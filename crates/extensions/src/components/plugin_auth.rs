//! 插件平台登录对话框：一次登录后凭据由引擎保存，后续插件请求自动复用。

use std::sync::Arc;
use std::time::Duration;

use fluxdown_protocol::{PluginAuthResponse, RpcErrorData};
use fluxdown_ui_i18n::Translator;
use fluxdown_ui_theme::CONTROL_HEIGHT;
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AppContext as _, Context, Entity, IntoElement, ParentElement, Render, Styled, Subscription,
    Window, div,
};
use gpui_component::{
    ActiveTheme as _, Disableable as _, Sizable as _, StyledExt as _, WindowExt as _,
    button::{Button, ButtonVariants as _},
    dialog::DialogFooter,
    input::{Input, InputState},
    v_flex,
};

use crate::controller::plugin_auth_call;
use crate::{ExtensionsPort, error_text};

pub struct PluginAuthDialog {
    translator: Entity<Translator>,
    port: Arc<dyn ExtensionsPort>,
    identity: String,
    site: Entity<InputState>,
    _site_subscription: Subscription,
    input: Entity<InputState>,
    session_id: String,
    auth_ref: String,
    status: String,
    challenge: Option<String>,
    challenge_type: Option<String>,
    message: Option<String>,
    busy: bool,
    poll_task_active: bool,
    logout_pending: bool,
}

impl PluginAuthDialog {
    pub fn new(
        translator: Entity<Translator>,
        port: Arc<dyn ExtensionsPort>,
        identity: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let site_placeholder = translator
            .read(cx)
            .text("pluginAuthSitePlaceholder")
            .to_owned();
        let input_placeholder = translator
            .read(cx)
            .text("pluginAuthInputPlaceholder")
            .to_owned();
        let site = cx.new(|cx| InputState::new(window, cx).placeholder(site_placeholder));
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(input_placeholder));
        let _site_subscription =
            cx.subscribe_in(&site, window, |this, input, event, window, cx| {
                if matches!(
                    event,
                    gpui_component::input::InputEvent::Blur
                        | gpui_component::input::InputEvent::PressEnter { .. }
                ) && !this.busy
                {
                    this.request_status(&input.read(cx).value(), window, cx);
                }
            });
        let dialog = Self {
            translator,
            port,
            identity,
            site,
            _site_subscription,
            input,
            session_id: String::new(),
            auth_ref: String::new(),
            status: String::new(),
            challenge: None,
            challenge_type: None,
            message: None,
            busy: true,
            poll_task_active: false,
            logout_pending: false,
        };
        let status_future =
            plugin_auth_call(&dialog.port, &dialog.identity, "status", "", "", "", "");
        cx.spawn_in(window, async move |this, cx| {
            let result = status_future.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                this.apply_result(result, false, window, cx);
                cx.notify();
            });
        })
        .detach();
        dialog
    }

    fn request_status(&mut self, site: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.busy = true;
        self.message = None;
        let future = plugin_auth_call(&self.port, &self.identity, "status", site, "", "", "");
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = future.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                this.apply_result(result, false, window, cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn call(&mut self, action: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.message = None;
        let identity = self.identity.clone();
        let site = self.site.read(cx).value().to_string();
        let input = self.input.read(cx).value().to_string();
        let session_id = self.session_id.clone();
        let notify_success = matches!(action, "begin" | "poll");
        let future = plugin_auth_call(
            &self.port,
            &identity,
            action,
            &site,
            &self.auth_ref,
            &session_id,
            &input,
        );
        self.logout_pending = action == "logout";
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = future.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                this.apply_result(result, notify_success, window, cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.session_id.is_empty() {
            window.close_dialog(cx);
            return;
        }
        let identity = self.identity.clone();
        let site = self.site.read(cx).value().to_string();
        let session_id = self.session_id.clone();
        let future = plugin_auth_call(
            &self.port,
            &identity,
            "cancel",
            &site,
            &self.auth_ref,
            &session_id,
            "",
        );
        window.close_dialog(cx);
        cx.spawn(async move |_this, _cx| {
            let _ = future.await;
        })
        .detach();
    }

    fn apply_response(
        &mut self,
        response: PluginAuthResponse,
        notify_success: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.status = response.status.clone();
        self.session_id = response.session_id;
        self.auth_ref = response.auth_ref.unwrap_or_default();
        self.challenge = response.challenge;
        self.challenge_type = response.challenge_type;
        self.message = (!response.message.is_empty()).then_some(response.message);
        if self.logout_pending && self.status == "success" {
            self.auth_ref.clear();
            self.session_id.clear();
            self.challenge = None;
            self.challenge_type = None;
            self.logout_pending = false;
        }
        if self.status == "pending"
            && self
                .challenge_type
                .as_deref()
                .is_some_and(|kind| kind.eq_ignore_ascii_case("qrcode"))
        {
            self.start_polling(window, cx);
        }
        if notify_success && response.status == "success" {
            window.push_notification(
                gpui_component::notification::Notification::success(
                    self.translator
                        .read(cx)
                        .text("pluginAuthSuccess")
                        .to_owned(),
                ),
                cx,
            );
        }
    }

    /// QR 登录每两秒轮询一次；实体销毁后 `update` 失败，任务自然退出。
    fn start_polling(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.poll_task_active {
            return;
        }
        self.poll_task_active = true;
        let port = self.port.clone();
        let identity = self.identity.clone();
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                let Ok(Some(future)) = this.update(cx, |this, cx| {
                    if this.busy
                        || this.session_id.is_empty()
                        || !this
                            .challenge_type
                            .as_deref()
                            .is_some_and(|kind| kind.eq_ignore_ascii_case("qrcode"))
                    {
                        this.poll_task_active = false;
                        return None;
                    }
                    this.busy = true;
                    cx.notify();
                    Some(plugin_auth_call(
                        &port,
                        &identity,
                        "poll",
                        this.site.read(cx).value().as_ref(),
                        &this.auth_ref,
                        &this.session_id,
                        this.input.read(cx).value().as_ref(),
                    ))
                }) else {
                    break;
                };
                let result = future.await;
                let Ok(()) = this.update_in(cx, |this, window, cx| {
                    this.busy = false;
                    this.apply_result(result, true, window, cx);
                    cx.notify();
                }) else {
                    break;
                };
            }
        })
        .detach();
    }

    fn apply_result(
        &mut self,
        result: Result<serde_json::Value, RpcErrorData>,
        notify_success: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match result {
            Ok(value) => match serde_json::from_value::<PluginAuthResponse>(value) {
                Ok(response) => self.apply_response(response, notify_success, window, cx),
                Err(_) => {
                    self.message = Some(
                        self.translator
                            .read(cx)
                            .text("pluginAuthInvalidResponse")
                            .to_owned(),
                    )
                }
            },
            Err(error) => {
                let text = error_text(self.translator.read(cx), &error);
                self.message = Some(
                    self.translator
                        .read(cx)
                        .text_with("pluginAuthFailed", &[("message", &text)]),
                );
            }
        }
    }
}

impl Render for PluginAuthDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let translator = self.translator.read(cx);
        let begin = translator.text("pluginAuthBegin").to_owned();
        let poll = translator.text("pluginAuthPoll").to_owned();
        let cancel = translator.text("cancel").to_owned();
        let status = match self.status.as_str() {
            "pending" => translator.text("pluginAuthPending").to_owned(),
            "success" => translator.text("pluginAuthSuccess").to_owned(),
            _ => String::new(),
        };
        let challenge = self.challenge.clone();
        let challenge_type = self.challenge_type.clone().unwrap_or_default();
        v_flex()
            .w_full()
            .gap_3()
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(translator.text("pluginAuthDescription").to_owned()),
            )
            .child(
                Input::new(&self.site)
                    .w_full()
                    .with_size(gpui_component::Size::Medium)
                    .disabled(self.busy),
            )
            .child(
                Input::new(&self.input)
                    .w_full()
                    .with_size(gpui_component::Size::Medium)
                    .disabled(self.busy),
            )
            .when(!status.is_empty(), |this| {
                this.child(div().text_sm().font_semibold().child(status))
            })
            .when_some(challenge, |this, value| {
                this.child(
                    v_flex()
                        .gap_1()
                        .p_2()
                        .rounded(theme.radius)
                        .bg(theme.secondary)
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(challenge_type),
                        )
                        .child(div().text_xs().child(value)),
                )
            })
            .when_some(self.message.clone(), |this, message| {
                this.child(div().text_xs().text_color(theme.danger).child(message))
            })
            .child(
                DialogFooter::new()
                    .child(
                        Button::new("plugin-auth-cancel")
                            .outline()
                            .label(cancel)
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.cancel(window, cx))),
                    )
                    .child(
                        div()
                            .when(self.auth_ref.is_empty(), |this| {
                                this.child(
                                    Button::new("plugin-auth-begin")
                                        .primary()
                                        .h(CONTROL_HEIGHT)
                                        .label(if self.session_id.is_empty() {
                                            begin
                                        } else {
                                            poll
                                        })
                                        .loading(self.busy)
                                        .disabled(self.busy)
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            let action = if this.session_id.is_empty() {
                                                "begin"
                                            } else {
                                                "poll"
                                            };
                                            this.call(action, window, cx);
                                        })),
                                )
                            })
                            .when(!self.auth_ref.is_empty(), |this| {
                                this.child(
                                    Button::new("plugin-auth-logout")
                                        .outline()
                                        .h(CONTROL_HEIGHT)
                                        .label(translator.text("pluginAuthLogout").to_owned())
                                        .loading(self.busy)
                                        .disabled(self.busy)
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.call("logout", window, cx);
                                        })),
                                )
                            }),
                    ),
            )
    }
}

//! 插件平台登录对话框：一次登录后凭据由引擎保存，后续插件请求自动复用。

use std::sync::Arc;

use fluxdown_protocol::PluginAuthResponse;
use fluxdown_ui_i18n::Translator;
use fluxdown_ui_theme::CONTROL_HEIGHT;
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AppContext as _, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div,
};
use gpui_component::{
    ActiveTheme as _, Disableable as _, Sizable as _, StyledExt as _, WindowExt as _,
    button::{Button, ButtonVariants as _},
    dialog::DialogFooter,
    input::{Input, InputState},
    v_flex,
};

use crate::{ExtensionsPort, error_text};

pub struct PluginAuthDialog {
    translator: Entity<Translator>,
    port: Arc<dyn ExtensionsPort>,
    identity: String,
    site: Entity<InputState>,
    input: Entity<InputState>,
    session_id: String,
    status: String,
    challenge: Option<String>,
    challenge_type: Option<String>,
    message: Option<String>,
    busy: bool,
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
        Self {
            translator,
            port,
            identity,
            site,
            input,
            session_id: String::new(),
            status: String::new(),
            challenge: None,
            challenge_type: None,
            message: None,
            busy: false,
        }
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
        let future = self.port.call(
            fluxdown_protocol::method::DAEMON_PLUGIN_AUTH,
            serde_json::json!({
                "identity": identity,
                "action": action,
                "site": site,
                "sessionId": session_id,
                "input": input,
            }),
        );
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = future.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match result {
                    Ok(value) => match serde_json::from_value::<PluginAuthResponse>(value) {
                        Ok(response) => this.apply_response(response, window, cx),
                        Err(_) => {
                            this.message = Some(
                                this.translator
                                    .read(cx)
                                    .text("pluginAuthInvalidResponse")
                                    .to_owned(),
                            )
                        }
                    },
                    Err(error) => {
                        let text = error_text(this.translator.read(cx), &error);
                        this.message = Some(
                            this.translator
                                .read(cx)
                                .text_with("pluginAuthFailed", &[("message", &text)]),
                        );
                    }
                }
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
        let future = self.port.call(
            fluxdown_protocol::method::DAEMON_PLUGIN_AUTH,
            serde_json::json!({
                "identity": identity,
                "action": "cancel",
                "site": site,
                "sessionId": session_id,
            }),
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
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.status = response.status.clone();
        self.session_id = response.session_id;
        self.challenge = response.challenge;
        self.challenge_type = response.challenge_type;
        self.message = (!response.message.is_empty()).then_some(response.message);
        if response.status == "success" {
            window.push_notification(
                gpui_component::notification::Notification::success(
                    self.translator
                        .read(cx)
                        .text("pluginAuthSuccess")
                        .to_owned(),
                ),
                cx,
            );
            window.close_dialog(cx);
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
                    ),
            )
    }
}

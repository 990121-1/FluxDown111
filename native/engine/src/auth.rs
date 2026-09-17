//! 插件通用认证凭据存储与请求注入。
//!
//! 插件只负责完成平台特有的登录流程，并把登录结果提交到这里；后续
//! `flux.fetch` 会按插件和站点自动查找并复用凭据。认证结果不放入插件自己的
//! KV 空间，避免每个插件重复实现持久化和过期判断。

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError};

/// 插件认证凭据配置键。
///
/// 仅作为旧版本整表存储的迁移兼容键；新写入按认证档案拆成独立 config 行。
pub const AUTH_PROFILES_CONFIG_KEY: &str = "plugin_auth_profiles";

/// 一份可复用的插件认证凭据。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProfile {
    /// 稳定引用。默认格式为 `plugin_id::site-key`。
    #[serde(default)]
    pub auth_ref: String,
    /// 创建该凭据的插件 ID。
    #[serde(default)]
    pub plugin_id: String,
    /// 站点键（host 或 host:port）。
    #[serde(default)]
    pub site: String,
    /// 平台账户名，可为空。
    #[serde(default)]
    pub account: String,
    /// `basic` / `cookie` / `bearer` / `headers` / `session`。
    #[serde(default)]
    pub kind: String,
    /// Cookie 请求头值。
    #[serde(default)]
    pub cookies: String,
    /// 需要注入的额外请求头。
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Bearer access token。保存后自动注入 `Authorization`，除非 headers 已提供。
    #[serde(default)]
    pub access_token: String,
    /// HTTP Basic 用户名（`kind = "basic"` 时使用）。
    #[serde(default)]
    pub username: String,
    /// HTTP Basic 密码（`kind = "basic"` 时使用）。
    #[serde(default)]
    pub password: String,
    /// 平台刷新流程使用的 token，由插件自行消费。
    #[serde(default)]
    pub refresh_token: String,
    /// Unix 秒；为空表示由服务端状态决定有效期（典型 Cookie）。
    #[serde(default)]
    pub expires_at: Option<i64>,
    /// Unix 秒；仅作为插件刷新提示，不会触发通用猜测式刷新。
    #[serde(default)]
    pub refresh_at: Option<i64>,
    /// 平台特有的非敏感元数据。
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

impl AuthProfile {
    /// 当前时间下凭据是否仍可使用。
    pub fn is_valid_at(&self, now: i64) -> bool {
        self.expires_at.is_none_or(|expires_at| expires_at > now)
    }

    /// 将通用认证材料注入请求头。插件自定义 headers 优先于自动生成的 Bearer。
    pub fn apply_to_headers(&self, headers: &mut HashMap<String, String>) {
        if !self.cookies.is_empty() && !headers.keys().any(|key| key.eq_ignore_ascii_case("cookie"))
        {
            headers.insert("Cookie".to_string(), self.cookies.clone());
        }
        if !self.access_token.is_empty()
            && !headers
                .keys()
                .any(|key| key.eq_ignore_ascii_case("authorization"))
        {
            headers.insert(
                "Authorization".to_string(),
                format!("Bearer {}", self.access_token),
            );
        }
        if self.kind.eq_ignore_ascii_case("basic")
            && (!self.username.is_empty() || !self.password.is_empty())
            && !headers
                .keys()
                .any(|key| key.eq_ignore_ascii_case("authorization"))
        {
            headers.insert(
                "Authorization".to_string(),
                crate::site_auth::basic_auth_value(&self.username, &self.password),
            );
        }
        for (name, value) in &self.headers {
            headers.insert(name.clone(), value.clone());
        }
    }
}

/// 从 URL 生成站点默认认证引用。
pub fn default_auth_ref(plugin_id: &str, url: &str) -> Option<String> {
    site_key(url).map(|site| format!("{plugin_id}::{site}"))
}

/// 从 URL 提取 host[:port] 站点键。
pub fn site_key(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?;
    match parsed.port() {
        Some(port) => Some(format!("{host}:{port}")),
        None => Some(host.to_string()),
    }
}

/// 规范化 UI/插件输入的站点：同时接受完整 URL 与 `host[:port]`。
pub fn normalize_site(input: &str) -> Option<String> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    site_key(input).or_else(|| site_key(&format!("https://{input}")))
}

/// 从配置中读取认证档案。
pub async fn load_all(db: &Db) -> Result<BTreeMap<String, AuthProfile>, DbError> {
    let mut store = BTreeMap::new();
    for (key, json) in db.list_config_with_prefix("plugin.").await? {
        if !is_profile_config_key(&key) {
            continue;
        }
        let profile: AuthProfile = serde_json::from_str(&json)
            .map_err(|error| DbError::InvalidConfig(format!("认证档案 {key} 解析失败: {error}")))?;
        if !profile.auth_ref.is_empty() {
            store.insert(profile.auth_ref.clone(), profile);
        }
    }
    if let Some(json) = db.get_config(AUTH_PROFILES_CONFIG_KEY).await?
        && !json.trim().is_empty()
    {
        let legacy: BTreeMap<String, AuthProfile> = serde_json::from_str(&json)
            .map_err(|error| DbError::InvalidConfig(format!("认证档案旧表解析失败: {error}")))?;
        for (auth_ref, profile) in legacy {
            store.entry(auth_ref).or_insert(profile);
        }
    }
    Ok(store)
}

/// 读取单份认证档案。
pub async fn load(db: &Db, auth_ref: &str) -> Result<Option<AuthProfile>, DbError> {
    if let Some(key) = profile_key_for_ref(auth_ref)
        && let Some(json) = db.get_config(&key).await?
    {
        let profile = serde_json::from_str(&json)
            .map_err(|error| DbError::InvalidConfig(format!("认证档案 {key} 解析失败: {error}")))?;
        return Ok(Some(profile));
    }
    let Some(json) = db.get_config(AUTH_PROFILES_CONFIG_KEY).await? else {
        return Ok(None);
    };
    if json.trim().is_empty() {
        return Ok(None);
    }
    let legacy: BTreeMap<String, AuthProfile> = serde_json::from_str(&json)
        .map_err(|error| DbError::InvalidConfig(format!("认证档案旧表解析失败: {error}")))?;
    Ok(legacy.get(auth_ref).cloned())
}

/// 写入或替换认证档案。
pub async fn save(db: &Db, profile: &AuthProfile) -> Result<(), DbError> {
    migrate_legacy(db).await?;
    let key = profile_config_key(profile);
    let json = serde_json::to_string(profile)
        .map_err(|error| DbError::InvalidConfig(format!("认证档案序列化失败: {error}")))?;
    db.set_config(&key, &json).await
}

/// 删除认证档案。
pub async fn remove(db: &Db, auth_ref: &str) -> Result<(), DbError> {
    migrate_legacy(db).await?;
    if let Some(key) = profile_key_for_ref(auth_ref) {
        db.delete_config(&key).await?;
    }
    Ok(())
}

/// 卸载插件时删除该插件的全部认证档案，包括旧版整表中的条目。
pub async fn remove_plugin(db: &Db, plugin_id: &str) -> Result<(), DbError> {
    let prefix = format!("plugin.{plugin_id}.auth.");
    for (key, _) in db.list_config_with_prefix(&prefix).await? {
        db.delete_config(&key).await?;
    }
    let Some(json) = db.get_config(AUTH_PROFILES_CONFIG_KEY).await? else {
        return Ok(());
    };
    if json.trim().is_empty() {
        return Ok(());
    }
    let mut legacy: BTreeMap<String, AuthProfile> = serde_json::from_str(&json)
        .map_err(|error| DbError::InvalidConfig(format!("认证档案旧表解析失败: {error}")))?;
    let auth_prefix = format!("{plugin_id}::");
    legacy.retain(|auth_ref, profile| {
        !auth_ref.starts_with(&auth_prefix) && profile.plugin_id != plugin_id
    });
    if legacy.is_empty() {
        db.delete_config(AUTH_PROFILES_CONFIG_KEY).await
    } else {
        let remaining = serde_json::to_string(&legacy)
            .map_err(|error| DbError::InvalidConfig(format!("认证档案旧表序列化失败: {error}")))?;
        db.set_config(AUTH_PROFILES_CONFIG_KEY, &remaining).await
    }
}

fn profile_config_key(profile: &AuthProfile) -> String {
    format!("plugin.{}.auth.{}", profile.plugin_id, profile.site)
}

fn profile_key_for_ref(auth_ref: &str) -> Option<String> {
    let (plugin_id, site) = auth_ref.split_once("::")?;
    if plugin_id.is_empty() || site.is_empty() {
        return None;
    }
    Some(format!("plugin.{plugin_id}.auth.{site}"))
}

async fn migrate_legacy(db: &Db) -> Result<(), DbError> {
    let Some(json) = db.get_config(AUTH_PROFILES_CONFIG_KEY).await? else {
        return Ok(());
    };
    if json.trim().is_empty() {
        db.delete_config(AUTH_PROFILES_CONFIG_KEY).await?;
        return Ok(());
    }
    let legacy: BTreeMap<String, AuthProfile> = serde_json::from_str(&json)
        .map_err(|error| DbError::InvalidConfig(format!("认证档案旧表解析失败: {error}")))?;
    let mut values = BTreeMap::new();
    for (auth_ref, mut profile) in legacy {
        let Some((plugin_id, site)) = auth_ref.split_once("::") else {
            return Err(DbError::InvalidConfig(format!(
                "认证档案 authRef 非法: {auth_ref}"
            )));
        };
        let plugin_id = plugin_id.to_string();
        let site = site.to_string();
        let Some(key) = profile_key_for_ref(&auth_ref) else {
            return Err(DbError::InvalidConfig(format!(
                "认证档案 authRef 非法: {auth_ref}"
            )));
        };
        // 旧表的 map key 才是可查找的权威引用；修复旧版本可能留下的
        // 空/不一致 profile.authRef 与 pluginId/site，避免迁移后读不到。
        profile.auth_ref = auth_ref;
        if profile.plugin_id.is_empty() {
            profile.plugin_id = plugin_id;
        }
        if profile.site.is_empty() {
            profile.site = site;
        }
        let value = serde_json::to_string(&profile)
            .map_err(|error| DbError::InvalidConfig(format!("认证档案序列化失败: {error}")))?;
        values.insert(key, value);
    }
    db.set_config_batch_atomic(&values).await?;
    db.delete_config(AUTH_PROFILES_CONFIG_KEY).await
}

fn is_profile_config_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("plugin.") else {
        return false;
    };
    let Some((identity, site)) = rest.split_once(".auth.") else {
        return false;
    };
    !identity.is_empty() && !identity.contains('.') && identity.contains('@') && !site.is_empty()
}

/// 返回当前 Unix 秒。
pub fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_ref_uses_normalized_site() {
        assert_eq!(
            default_auth_ref("bilibili@example", "https://Example.COM:443/video"),
            Some("bilibili@example::example.com".to_string())
        );
    }

    #[test]
    fn cookie_and_bearer_are_injected_without_overwriting_explicit_headers() {
        let profile = AuthProfile {
            cookies: "sid=1".to_string(),
            access_token: "token".to_string(),
            ..Default::default()
        };
        let mut headers = HashMap::from([("Authorization".to_string(), "Basic x".to_string())]);
        profile.apply_to_headers(&mut headers);
        assert_eq!(headers.get("Cookie").map(String::as_str), Some("sid=1"));
        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("Basic x")
        );
    }

    #[test]
    fn basic_profile_is_injected() {
        let profile = AuthProfile {
            kind: "basic".to_string(),
            username: "Aladdin".to_string(),
            password: "open sesame".to_string(),
            ..Default::default()
        };
        let mut headers = HashMap::new();
        profile.apply_to_headers(&mut headers);
        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==")
        );
    }

    #[test]
    fn normalize_site_accepts_url_or_host() {
        assert_eq!(
            normalize_site("https://Example.COM/path"),
            Some("example.com".to_string())
        );
        assert_eq!(
            normalize_site("example.com:8443"),
            Some("example.com:8443".to_string())
        );
    }

    #[test]
    fn expiry_is_strict() {
        let profile = AuthProfile {
            expires_at: Some(100),
            ..Default::default()
        };
        assert!(profile.is_valid_at(99));
        assert!(!profile.is_valid_at(100));
    }
}

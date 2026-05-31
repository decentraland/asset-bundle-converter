use serde::{Deserialize, Serialize};

/// Mirrors the Unity-side `BuildTarget` enum used by the existing converter
/// (see asset-bundle-converter/Assets/AssetBundleConverter/AssetBundleConverter.cs:126).
/// Pods are pinned to one target at construction time; cross-target requests
/// throw `TARGET_MISMATCH` rather than re-encoding for a different platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildTarget {
    Windows,
    Mac,
    Webgl,
}

impl BuildTarget {
    /// The suffix Unity emits in bundle filenames (`{hash}_{target}`).
    /// Matches `PlatformUtils.GetPlatform()` in the Unity converter and the
    /// `[^/]+_(?:webgl|windows|mac)(\.br|\.manifest|\.manifest\.br)?` regex
    /// the consumer-server side uses to classify uploads.
    pub fn filename_suffix(self) -> &'static str {
        match self {
            BuildTarget::Windows => "_windows",
            BuildTarget::Mac => "_mac",
            BuildTarget::Webgl => "_webgl",
        }
    }
}

impl std::str::FromStr for BuildTarget {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "windows" => Ok(BuildTarget::Windows),
            "mac" => Ok(BuildTarget::Mac),
            "webgl" => Ok(BuildTarget::Webgl),
            other => Err(format!("invalid build target: {other}")),
        }
    }
}

/// Mirrors the Unity converter's `AnimationMethod` (ClientSettings.cs) and
/// the `GetAnimationMethod(isEmote, isWearable)` decision in
/// AssetBundleConverter.cs:625 — emote → Mecanim (Animator + AnimatorController),
/// wearable → None (no animation component), else Legacy (Animation + clips).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AnimationMethod {
    #[default]
    Legacy,
    Mecanim,
    None,
}

impl AnimationMethod {
    /// The Unity rule: wearable → None, emote → Mecanim, else Legacy.
    pub fn from_entity(is_emote: bool, is_wearable: bool) -> Self {
        if is_wearable {
            AnimationMethod::None
        } else if is_emote {
            AnimationMethod::Mecanim
        } else {
            AnimationMethod::Legacy
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShaderType {
    /// `DCL/Scene` and friends — the default for the production converter.
    Dcl,
    /// glTFast's PbrMetallicRoughness shader — alternate path, not used in
    /// production today but kept for parity with the Unity converter's flag.
    Gltfast,
}

impl std::str::FromStr for ShaderType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "dcl" => Ok(ShaderType::Dcl),
            "gltfast" => Ok(ShaderType::Gltfast),
            other => Err(format!("invalid shader type: {other}")),
        }
    }
}

/// One entry in the bake-time shader manifest. Each Material the encoder
/// writes embeds an external reference whose GUID matches this `guid` and
/// path-ID matches `path_id`. Resolved at deserialization time by the
/// Explorer's loaded shader registry (Shader.Find by name backed by GUID).
///
/// See `unity-explorer/Explorer/Library/PackageCache/com.decentraland.unity-shared-dependencies/`
/// for the shader sources; the bake step extracts the .meta GUIDs once and
/// uploads this map to S3, keyed by BAKE_VERSION + BUILD_TARGET.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShaderEntry {
    /// The 32-char hex GUID from the shader's .meta file
    /// (e.g. `56a9743f8d94f6840acf5b4b8d2c4e1a` for DCL/Scene).
    pub guid: String,
    /// The file-ID of the shader sub-asset (typically 4800000 for shaders).
    pub path_id: i64,
    /// The Unity ClassID type marker. For shaders this is `3`.
    /// (Reference: Unity's internal type table; SerializedFile external refs.)
    #[serde(default = "default_shader_type")]
    pub asset_type: i32,
}

fn default_shader_type() -> i32 {
    3
}

/// Top-level shader manifest loaded once at encoder start. Keyed by the
/// shader name string the encoder writes into Material assets (e.g.
/// `"DCL/Scene"`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ShaderManifest {
    pub entries: std::collections::HashMap<String, ShaderEntry>,
}

/// Metadata for the loaded bake. Surfaced in logs so a misconfigured pod
/// (wrong BAKE_VERSION for the current AB_VERSION, Unity version drift) is
/// diagnosable from a single log line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeInfo {
    pub unity_version: String,
    pub bake_version: String,
    pub bake_date: String,
}

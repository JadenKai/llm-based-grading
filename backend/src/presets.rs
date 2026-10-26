//! Bundled example essays (`examples/essays/*.docx`) and rubrics (`examples/rubrics/*.json`)
//! offered on the landing page. Override the directory with `GRADER_PRESETS_DIR`.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use ts_rs::TS;

use crate::rubric::Rubric;

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct EssayPreset {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct RubricPreset {
    pub id: String,
    pub name: String,
    pub total_points: f32,
    pub criteria: u32,
}

#[derive(Serialize, TS, Clone, Debug, Default)]
#[ts(export)]
pub struct Presets {
    pub essays: Vec<EssayPreset>,
    pub rubrics: Vec<RubricPreset>,
}

pub fn dir() -> PathBuf {
    std::env::var("GRADER_PRESETS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../examples")))
}

fn files(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == ext)).collect())
        .unwrap_or_default();
    v.sort();
    v
}

/// `dc:title` from a .docx's core properties, if present.
pub fn docx_title(bytes: &[u8]) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut xml = String::new();
    zip.by_name("docProps/core.xml").ok()?.read_to_string(&mut xml).ok()?;
    let start = xml.find("<dc:title>")? + "<dc:title>".len();
    let end = start + xml[start..].find("</dc:title>")?;
    let t = xml[start..end].replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&");
    Some(t.trim().to_string()).filter(|t| !t.is_empty())
}

fn file_id(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn list() -> Presets {
    let root = dir();
    let essays = files(&root.join("essays"), "docx")
        .into_iter()
        .map(|p| EssayPreset {
            name: std::fs::read(&p)
                .ok()
                .and_then(|b| docx_title(&b))
                .unwrap_or_else(|| p.file_stem().unwrap_or_default().to_string_lossy().replace(['-', '_'], " ")),
            id: file_id(&p),
        })
        .collect();
    let rubrics = files(&root.join("rubrics"), "json")
        .into_iter()
        .filter_map(|p| {
            let r = Rubric::parse(&std::fs::read(&p).ok()?)
                .map_err(|e| tracing::warn!("skipping preset rubric {}: {e}", p.display()))
                .ok()?;
            Some(RubricPreset {
                id: file_id(&p),
                name: r.title.clone(),
                total_points: r.total(),
                criteria: r.criteria.len() as u32,
            })
        })
        .collect();
    Presets { essays, rubrics }
}

/// Bytes of a preset file. `id` must be a plain file name from the listing.
pub fn read(kind: &str, id: &str) -> Option<Vec<u8>> {
    if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') {
        return None;
    }
    std::fs::read(dir().join(kind).join(id)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_bundled_presets_and_rejects_traversal() {
        let p = list();
        assert!(!p.essays.is_empty() && !p.rubrics.is_empty());
        assert!(read("essays", &p.essays[0].id).is_some());
        assert!(read("essays", "../Cargo.toml").is_none());
        assert!(read("rubrics", ".hidden").is_none());
    }
}

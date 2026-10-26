//! Property lists, as Safari keeps its bookmarks (`Bookmarks.plist`). The
//! file is binary; the system's `plutil` turns it into XML, which this reads
//! into JSON values. JSON can't come straight from `plutil`: the reading
//! list's dates and data have no JSON form.

use serde_json::{Map, Value};

use crate::ImportError;

/// `path`, a property list in any of the system's formats, as a value.
pub(crate) fn read(path: &std::path::Path) -> Result<Value, ImportError> {
    std::fs::File::open(path)?; // a protected file fails here, plainly
    let out = std::process::Command::new("/usr/bin/plutil")
        .args(["-convert", "xml1", "-o", "-"])
        .arg(path)
        .output()?;
    if !out.status.success() {
        return Err(ImportError::Other(format!(
            "plutil couldn't read {}: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

/// An XML property list as a value: dicts are objects, arrays arrays,
/// strings, dates and data are strings, numbers numbers.
pub(crate) fn parse(xml: &str) -> Result<Value, ImportError> {
    let mut p = Parser { s: xml, i: 0 };
    p.skip_to("<plist")?;
    p.skip_to(">")?;
    p.i += 1;
    p.value()
}

struct Parser<'a> {
    s: &'a str,
    i: usize,
}

fn bad(what: &str) -> ImportError {
    ImportError::Other(format!("not a property list: {what}"))
}

fn unescape(t: &str) -> String {
    t.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

impl Parser<'_> {
    fn rest(&self) -> &str {
        &self.s[self.i..]
    }

    fn skip_to(&mut self, pat: &str) -> Result<(), ImportError> {
        let at = self.rest().find(pat).ok_or_else(|| bad(pat))?;
        self.i += at;
        Ok(())
    }

    /// The next tag's name (`dict`, `/dict`, `true/`), past comments and text.
    fn tag(&mut self) -> Result<String, ImportError> {
        loop {
            self.skip_to("<")?;
            if self.rest().starts_with("<!--") {
                self.skip_to("-->")?;
                continue;
            }
            if self.rest().starts_with("<?") || self.rest().starts_with("<!") {
                self.skip_to(">")?;
                continue;
            }
            let end = self.rest().find('>').ok_or_else(|| bad("tag"))?;
            let name = self.rest()[1..end].trim().to_string();
            self.i += end + 1;
            return Ok(name);
        }
    }

    /// Text up to `</name>`, unescaped.
    fn text(&mut self, name: &str) -> Result<String, ImportError> {
        let close = format!("</{name}>");
        let at = self.rest().find(&close).ok_or_else(|| bad(&close))?;
        let t = unescape(&self.rest()[..at]);
        self.i += at + close.len();
        Ok(t)
    }

    fn value(&mut self) -> Result<Value, ImportError> {
        let tag = self.tag()?;
        self.value_from(&tag)
    }

    fn value_from(&mut self, tag: &str) -> Result<Value, ImportError> {
        Ok(match tag {
            "dict" => {
                let mut map = Map::new();
                loop {
                    let t = self.tag()?;
                    match t.as_str() {
                        "/dict" => break,
                        "key" => {
                            let k = self.text("key")?;
                            let v = self.value()?;
                            map.insert(k, v);
                        }
                        other => return Err(bad(other)),
                    }
                }
                Value::Object(map)
            }
            "dict/" => Value::Object(Map::new()),
            "array" => {
                let mut list = Vec::new();
                loop {
                    let t = self.tag()?;
                    if t == "/array" {
                        break;
                    }
                    list.push(self.value_from(&t)?);
                }
                Value::Array(list)
            }
            "array/" => Value::Array(Vec::new()),
            "string" | "date" | "data" => Value::String(self.text(tag)?),
            "string/" => Value::String(String::new()),
            "integer" | "real" => {
                let t = self.text(tag)?;
                t.trim()
                    .parse::<i64>()
                    .map(Value::from)
                    .or_else(|_| t.trim().parse::<f64>().map(Value::from))
                    .unwrap_or(Value::Null)
            }
            "true/" => Value::Bool(true),
            "false/" => Value::Bool(false),
            other => return Err(bad(other)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_safari_shaped_bookmarks() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Children</key>
	<array>
		<dict>
			<key>Children</key>
			<array>
				<dict>
					<key>URIDictionary</key>
					<dict><key>title</key><string>Rust &amp; WebKit</string></dict>
					<key>URLString</key>
					<string>https://example.com/?a=1&amp;b=2</string>
					<key>WebBookmarkType</key>
					<string>WebBookmarkTypeLeaf</string>
				</dict>
			</array>
			<key>Title</key>
			<string>BookmarksBar</string>
			<key>WebBookmarkType</key>
			<string>WebBookmarkTypeList</string>
		</dict>
		<dict>
			<key>ReadingList</key>
			<dict><key>DateAdded</key><date>2026-10-01T10:00:00Z</date><key>Seen</key><false/></dict>
			<key>Sync</key><dict><key>Data</key><data>AAEC</data></dict>
			<key>Children</key><array/>
			<key>Count</key><integer>3</integer>
		</dict>
	</array>
	<key>WebBookmarkFileVersion</key>
	<integer>1</integer>
</dict>
</plist>"#;
        let v = parse(xml).unwrap();
        let bar = &v["Children"][0];
        assert_eq!(bar["Title"], "BookmarksBar");
        assert_eq!(
            bar["Children"][0]["URIDictionary"]["title"],
            "Rust & WebKit"
        );
        assert_eq!(
            bar["Children"][0]["URLString"],
            "https://example.com/?a=1&b=2"
        );
        assert_eq!(v["Children"][1]["ReadingList"]["Seen"], false);
        assert_eq!(v["Children"][1]["Count"], 3);
        assert_eq!(v["Children"][1]["Children"], Value::Array(vec![]));
        assert_eq!(v["WebBookmarkFileVersion"], 1);
    }

    #[test]
    fn rejects_what_isnt_a_plist() {
        assert!(parse("<html><body/></html>").is_err());
        assert!(parse("<plist><dict><key>a</key><nonsense/></dict></plist>").is_err());
    }
}

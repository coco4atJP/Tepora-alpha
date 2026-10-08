use super::*;
use tepora_core::json_codec;
#[test]
fn frozen_source_html_entities_and_duckduckgo() {
    let cases = json_codec::parse(include_str!("../fixtures/source.json")).unwrap();
    for c in cases["html"].as_array().unwrap() {
        assert_eq!(
            html_to_markdown(
                c["html"].as_str().unwrap(),
                c["url"].as_str().unwrap(),
                c["main"].as_bool().unwrap()
            )
            .unwrap()
            .value(),
            c["expected"],
            "{c}"
        );
    }
    for c in cases["entities"].as_array().unwrap() {
        assert_eq!(
            decode_entities(c["text"].as_str().unwrap()),
            c["expected"].as_str().unwrap(),
            "{c}"
        );
    }
    for c in cases["duck"].as_array().unwrap() {
        let actual = parse_duckduckgo(c["html"].as_str().unwrap());
        if c["error"] == true {
            assert!(actual.is_err(), "{c}");
        } else {
            assert_eq!(json!(actual.unwrap()), c["expected"], "{c}");
        }
    }
}
#[test]
fn six_million_utf16_units_and_surrogate_entity_are_preserved() {
    let input = format!("{}😀tail", "x".repeat(5_999_999));
    let out = html_to_markdown(&input, "https://example.test/", false).unwrap();
    let units = utf16_units(&out.markdown);
    assert_eq!(units.len(), 6_000_000);
    assert_eq!(units.last(), Some(&0xd83d));
    assert_eq!(
        utf16_units(&decode_entities("&#xd800; &#xDFFF;")),
        [0xd800, 32, 0xdfff]
    );
}

#[test]
fn rejects_ragged_table_amplification_before_padding() {
    // Less than 100 KiB of HTML would otherwise create millions of empty cells.
    let mut html = format!("<table><tr>{}</tr>", "<td>x</td>".repeat(3000));
    html.push_str(&"<tr><td>x</td></tr>".repeat(3000));
    html.push_str("</table>");
    let error = html_to_markdown(&html, "https://example.test/", false).unwrap_err();
    assert_eq!(error.status, 413);
    assert!(error.message.contains("budget"));
}
#[test]
fn rejects_excessive_render_nesting_and_total_nodes() {
    for (open, close) in [
        ("<blockquote>", "</blockquote>"),
        ("<ul>", "</ul>"),
        ("<pre>", "</pre>"),
    ] {
        let html = format!("{}x{}", open.repeat(257), close.repeat(257));
        let e = html_to_markdown(&html, "https://example.test/", false).unwrap_err();
        assert_eq!(e.status, 413);
        assert!(e.message.contains("nesting"));
    }
    let e = html_to_markdown(
        &"<br>".repeat(MAX_HTML_NODES + 1),
        "https://example.test/",
        false,
    )
    .unwrap_err();
    assert_eq!(e.status, 413);
    assert!(e.message.contains("node"));
}
#[test]
fn rejects_link_and_quote_output_amplification_at_fixed_utf8_budget() {
    // The URL is reused in many short anchors; capacity is checked before format!.
    let base = format!("https://example.test/{}", "a".repeat(25000));
    let html = "<a href='?x'>x</a>".repeat(1200);
    let e = html_to_markdown(&html, &base, false).unwrap_err();
    assert_eq!(e.status, 413);
    assert!(e.message.contains("24 MiB"));
    let html = format!(
        "{}{}{}",
        "<blockquote>".repeat(256),
        "x<br>".repeat(50000),
        "</blockquote>".repeat(256)
    );
    let e = html_to_markdown(&html, "https://example.test/", false).unwrap_err();
    assert_eq!(e.status, 413);
    assert!(e.message.contains("24 MiB"));
}

//! Text segmentation utilities.
//!
//! Provides functions to split text into semantic sentences,
//! respecting minimum token lengths and language boundaries.

/// Splits a block of text into a vector of sentences.
///
/// This uses basic punctuation heuristics and length thresholds
/// to ensure sentences are meaningful units for embedding.
///
/// # Arguments
/// * `text` - The input text to split
/// * `min_tokens` - Minimum number of tokens (words/characters) per sentence.
///                  Shorter sentences will be merged with the previous one.
pub fn split_sentences(text: &str, min_tokens: usize) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current_sentence = String::new();
    let mut current_tokens = 0;

    let raw_sentences = custom_split(text);

    for raw_sentence in raw_sentences {
        let trimmed = raw_sentence.trim();
        if trimmed.is_empty() {
            continue;
        }

        if !current_sentence.is_empty() {
            current_sentence.push(' ');
        }
        current_sentence.push_str(trimmed);
        
        let tokens = trimmed.split_whitespace().count().max(trimmed.chars().count() / 3);
        current_tokens += tokens;

        // '\n' is a hard break, otherwise wait until we have enough tokens
        let is_hard_break = trimmed.ends_with('\n');

        if current_tokens >= min_tokens || is_hard_break {
            sentences.push(current_sentence.trim().to_string());
            current_sentence = String::new();
            current_tokens = 0;
        }
    }

    let final_sentence = current_sentence.trim();
    if !final_sentence.is_empty() {
        if sentences.is_empty() {
            sentences.push(final_sentence.to_string());
        } else {
            let last = sentences.last_mut().unwrap();
            last.push(' ');
            last.push_str(final_sentence);
        }
    }

    sentences
}

fn custom_split(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    
    for c in text.chars() {
        current.push(c);
        if is_strong_terminal(&c.to_string()) {
            result.push(current);
            current = String::new();
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

fn is_strong_terminal(text: &str) -> bool {
    let last_char = text.chars().last().unwrap_or(' ');
    matches!(last_char, '.' | '?' | '!' | '。' | '？' | '！' | '\n')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_sentences_basic() {
        let text = "Hello world. This is a test. Another sentence!";
        let sentences = split_sentences(text, 2);
        assert_eq!(
            sentences,
            vec!["Hello world.", "This is a test.", "Another sentence!"]
        );
    }

    #[test]
    fn test_split_sentences_japanese() {
        let text = "こんにちは。これはテストです！次の文です。";
        let sentences = split_sentences(text, 2);
        assert_eq!(
            sentences,
            vec!["こんにちは。", "これはテストです！", "次の文です。"]
        );
    }

    #[test]
    fn test_split_sentences_min_tokens() {
        let text = "Hi. This is a longer sentence that should stand alone. Bye.";
        let sentences = split_sentences(text, 5); 
        assert_eq!(
            sentences,
            vec![
                "Hi. This is a longer sentence that should stand alone. Bye."
            ]
        );
    }
}

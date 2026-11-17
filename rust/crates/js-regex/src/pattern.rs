//! Leitura do texto do padrão, sem compilar: os grupos de captura, quantos e
//! os nomes, na ordem.

/// Os grupos de captura do padrão, na ordem: `None` para o grupo sem nome.
pub(crate) fn capture_names(source: &str) -> Vec<Option<String>> {
    let chars: Vec<char> = source.chars().collect();
    let mut names = Vec::new();
    let mut in_class = false;
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 1,
            '[' if !in_class => in_class = true,
            ']' if in_class => in_class = false,
            '(' if !in_class => {
                if chars.get(i + 1) != Some(&'?') {
                    names.push(None);
                } else if chars.get(i + 2) == Some(&'<')
                    && !matches!(chars.get(i + 3), Some('=') | Some('!'))
                {
                    let name: String = chars[i + 3..].iter().take_while(|c| **c != '>').collect();
                    names.push(Some(name));
                }
            }
            _ => {}
        }
        i += 1;
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grupos_e_nomes() {
        assert_eq!(
            capture_names(r"(a)(?:b)(?<dia>\d+)[(](?=x)(?<!y)\((c)"),
            vec![None, Some("dia".to_owned()), None]
        );
    }
}

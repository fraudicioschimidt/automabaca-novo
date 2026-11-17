//! Data e hora do jogo escritas no post, portado de `parseBrKickoffDetailed`
//! (`src/domain/dates-parsing.ts`): "27/09 16:00", "2026-08-02 às 20h",
//! "11 Sep 13:30", "hoje 21:30", sempre no relógio de São Paulo. Os regexes
//! são os do TypeScript, letra por letra, pelo `js-regex`.

use crate::dates::{DateError, SAO_PAULO_UTC_OFFSET_HOURS, sp_to_utc};
use crate::js::date;
use js_regex::{Captures, Regex, regex};

/// O instante (ms) e se a hora foi inventada (só dia e mês no texto).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParsedKickoff {
    pub ms: f64,
    pub date_only: bool,
}

const THIRTY_DAYS_MS: f64 = 30.0 * 86_400_000.0;
const WEEKDAYS: [&str; 7] = [
    "domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado",
];
const ENGLISH_MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// Palavras que podem vir entre a data e a hora: "às", "horário" e o dia da semana.
macro_rules! date_time_filler {
    () => {
        r"(?<!\p{L})(?:[aà]s?|hor[aá](?:rio)?|dom(?:ingo)?|seg(?:unda)?|ter(?:[cç]a)?|qua(?:rta)?|qui(?:nta)?|sex(?:ta)?|s[aá]b(?:ado)?)(?:-feira)?(?!\p{L})"
    };
}

fn english_month_date() -> &'static Regex {
    regex!(
        r"\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\.?(?:\s*,?\s+(\d{4})\b)?",
        "gi"
    )
}

fn zoned_iso() -> &'static Regex {
    regex!(
        r"\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))\b",
        "gi"
    )
}

fn iso_date() -> &'static Regex {
    regex!(
        r"\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[T \t]+(?:às[ \t]*)?(\d{1,2})(?:(?:[:h](\d{2}))|h\b))?\b",
        "gi"
    )
}

fn zone_suffix() -> &'static Regex {
    regex!(r"^(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b", "i")
}

fn br_date() -> &'static Regex {
    regex!(
        r"(?<!\d[/.])\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?:[ \t]*[-–—,]?[ \t]*(?:às[ \t]*)?(\d{1,2})(?:(?:[:h](\d{2}))|h\b))?\b",
        "gi"
    )
}

/// Hora na MESMA linha logo depois da data ("27/09 | 16:00", "📅 27/09 ⏰
/// 16:00"): ver o comentário de `TIME_LATER_ON_DATE_LINE` no TypeScript.
fn time_later_on_date_line() -> &'static Regex {
    regex!(
        concat!(
            r"^(?=[^\n\d@]{0,16}\d)(?:[^\p{L}\d@\n]|",
            date_time_filler!(),
            r")*?([01]?\d|2[0-4])(?::([0-5]\d)|h(?:([0-5]\d)|rs?|s)?)(?:[ \t]?(?:hs|hrs?|h|min))?(?![\p{L}\d:]|[.,]\d)"
        ),
        "iu"
    )
}

/// Rótulo de odd logo antes do número: é o preço, não dia e mês.
fn odd_label_before() -> &'static Regex {
    regex!(
        r"(?:@|\b(?:odd?s?|cota(?:[cç][aã]o)?|pre[cç]o))\s*[:=\-]?\s*$",
        "i"
    )
}

/// Direção, handicap ou sinal colado antes de "N/N": linha de mercado.
fn line_before() -> &'static Regex {
    regex!(
        r"(?:\b(?:over|under|mais|menos|acima|abaixo|handicap|ah|eh|linha)(?:\s+de)?\s*|[+\-])$",
        "i"
    )
}

/// "2/7 da série", "1/3 da melhor de 5": o jogo da série, não a data.
fn series_after() -> &'static Regex {
    regex!(r"^\s*d[aeo]\s+(?:s[eé]rie|melhor)", "i")
}

fn decimal_after() -> &'static Regex {
    regex!(r"^[.,]\d", "")
}

fn total_direction_before() -> &'static Regex {
    regex!(r"(?:over|under|mais|menos|acima|abaixo|[+\-@])\s*$", "i")
}

/// Texto logo antes de um número que faz dele a nota do tipster ("Confiança 5/5", "⭐ 3").
fn rating_before() -> &'static Regex {
    regex!(
        r"(?:confian[cç]a|nota|rating|n[ií]vel|estrelas?|⭐|🌟|★)[^\n\d]{0,12}$",
        "i"
    )
}

/// Dia relativo com hora na mesma linha: "hoje 21:30", "sábado 16:00".
fn relative_day_time() -> &'static Regex {
    regex!(
        r"(?<!\p{L})(hoje|amanh[ãa]|domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)(?:-feira)?(?!\p{L})[ \t,\-–|•]*(?:[àa]s[ \t]*)?([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)(?:[ \t]?(?:hs|hrs?|h))?(?![\p{L}\d:]|[.,]\d)",
        "iu"
    )
}

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        english_month_date(),
        zoned_iso(),
        iso_date(),
        zone_suffix(),
        br_date(),
        time_later_on_date_line(),
        odd_label_before(),
        line_before(),
        series_after(),
        decimal_after(),
        total_direction_before(),
        rating_before(),
        relative_day_time(),
    ]
}

/// `Number(texto)` de um grupo de dígitos; NaN se o grupo não participou.
fn number(captures: &Captures<'_>, group: usize) -> f64 {
    captures
        .get(group)
        .and_then(|digits| digits.parse::<f64>().ok())
        .unwrap_or(f64::NAN)
}

/// `utcToSpParts`: os campos do relógio de São Paulo; erro na data inválida.
fn sp_parts(ms: f64) -> Result<date::Parts, DateError> {
    date::parts(ms - SAO_PAULO_UTC_OFFSET_HOURS * 3_600_000.0)
        .filter(|_| ms.is_finite())
        .ok_or_else(|| DateError("utcToSpParts: data inválida.".to_owned()))
}

fn time_later(text: &str, date_end: usize) -> Option<(f64, f64)> {
    let found = time_later_on_date_line().exec(text.get(date_end..)?)?;
    let hour = number(&found, 1);
    let minute = found
        .get(2)
        .or_else(|| found.get(3))
        .map_or(0.0, |digits| digits.parse().unwrap_or(f64::NAN));
    // Hora impossível ("27/09 | 24:30") não é a do jogo, e a data continua valendo sem ela.
    (!(hour == 24.0 && minute != 0.0)).then_some((hour, minute))
}

/// O dia de calendário existe (`Date.UTC` não fez rollover).
fn calendar_day(year: f64, month: f64, day: f64) -> Option<date::Parts> {
    let parts = date::parts(date::utc(year, month - 1.0, day, 0.0, 0.0))?;
    (parts.year as f64 == year && parts.month0 as f64 == month - 1.0 && parts.day as f64 == day)
        .then_some(parts)
}

/// O alvo (dia seguinte quando a hora é 24:00) e o instante em São Paulo, se
/// os componentes voltam iguais.
fn sp_instant(
    source: date::Parts,
    rolls_to_next_day: bool,
    hour: f64,
    minute: f64,
) -> Result<Option<f64>, DateError> {
    let mut target = source;
    if rolls_to_next_day {
        let next = date::utc(
            source.year as f64,
            source.month0 as f64,
            source.day as f64 + 1.0,
            0.0,
            0.0,
        );
        match date::parts(next) {
            Some(parts) => target = parts,
            None => return Ok(None),
        }
    }
    let target_hour = if rolls_to_next_day { 0.0 } else { hour };
    let result = sp_to_utc(
        target.year as f64,
        target.month0 as f64 + 1.0,
        target.day as f64,
        target_hour,
        minute,
    );
    if result.is_nan() {
        return Ok(None);
    }
    let sp = sp_parts(result)?;
    let same = sp.year == target.year
        && sp.month0 == target.month0
        && sp.day == target.day
        && sp.hour as f64 == target_hour
        && sp.minute as f64 == minute;
    Ok(same.then_some(result))
}

/// `parseBrKickoffDetailed(text, ref)`, com `ref` em ms.
pub fn parse_br_kickoff(text: &str, ref_ms: f64) -> Result<Option<ParsedKickoff>, DateError> {
    // Datas de casa em inglês ("11 Sep 13:30") viram "11/9" antes do resto.
    let text = english_month_date().replace_with(text, |found| {
        let month = found.get(2).unwrap_or_default();
        let prefix: String = month.chars().take(3).collect::<String>().to_lowercase();
        let index = ENGLISH_MONTHS
            .iter()
            .position(|name| *name == prefix)
            .map_or(0, |i| i + 1);
        let day = found.get(1).unwrap_or_default();
        match found.get(3) {
            Some(year) if !year.is_empty() => format!("{day}/{index}/{year}"),
            _ => format!("{day}/{index}"),
        }
    });
    let text = text.as_str();

    // ISO que declara fuso é um instante absoluto, antes da leitura em São Paulo.
    for found in zoned_iso().exec_all(text) {
        let timestamp = found.get(1).unwrap_or_default();
        let calendar = timestamp.get(..10).unwrap_or_default();
        let source_day = date::parse_iso_zoned(&format!("{calendar}T00:00:00Z"));
        let parsed = date::parse_iso_zoned(timestamp);
        let same_day =
            date::to_iso_string(source_day).is_some_and(|iso| iso.get(..10) == Some(calendar));
        if source_day.is_finite() && same_day && parsed.is_finite() {
            return Ok(Some(ParsedKickoff {
                ms: parsed,
                date_only: false,
            }));
        }
    }

    // ISO explícito antes de DD/MM, para "2026/08/02" não virar 08/02.
    for found in iso_date().exec_all(text) {
        let end = found.end();
        if zone_suffix().is_match(text.get(end..).unwrap_or_default()) {
            continue;
        }
        let (year, month, day) = (number(&found, 1), number(&found, 2), number(&found, 3));
        let written_time = found.get(4).is_some();
        let later = if written_time {
            None
        } else {
            time_later(text, end)
        };
        let has_time = written_time || later.is_some();
        let hour = later.map_or(
            if has_time { number(&found, 4) } else { 0.0 },
            |(hour, _)| hour,
        );
        let minute = later.map_or(
            found.get(5).map_or(0.0, |_| number(&found, 5)),
            |(_, minute)| minute,
        );
        let rolls = hour == 24.0 && minute == 0.0;
        if !(1.0..=12.0).contains(&month)
            || !(1.0..=31.0).contains(&day)
            || hour > 24.0
            || (hour == 24.0 && minute != 0.0)
            || minute > 59.0
        {
            continue;
        }
        let Some(source) = calendar_day(year, month, day) else {
            continue;
        };
        if let Some(ms) = sp_instant(source, rolls, hour, minute)? {
            return Ok(Some(ParsedKickoff {
                ms,
                date_only: !has_time,
            }));
        }
    }

    // A PRIMEIRA data válida de todas as ocorrências: "Over 2.5" casa dd.mm
    // e é pulada quando há data real depois.
    for found in br_date().exec_all(text) {
        let (day, month) = (number(&found, 1), number(&found, 2));
        if !(1.0..=31.0).contains(&day) || !(1.0..=12.0).contains(&month) {
            continue;
        }
        let whole = found.get(0).unwrap_or_default();
        let has_year = found.get(3).is_some();
        let has_time = found.get(4).is_some();
        let slash = whole.contains('/');
        if !slash && !has_time && !has_year {
            continue;
        }
        let before = text.get(..found.start()).unwrap_or_default();
        if odd_label_before().is_match(before) {
            continue;
        }
        let after = text.get(found.end()..).unwrap_or_default();
        if slash
            && !has_year
            && (line_before().is_match(before)
                || decimal_after().is_match(after)
                || series_after().is_match(after))
        {
            continue;
        }
        if !slash
            && !has_year
            && (found.get(2) == Some("5") || total_direction_before().is_match(before))
        {
            continue;
        }
        if !has_year && !has_time && rating_before().is_match(before) {
            continue;
        }
        let later = if has_time {
            None
        } else {
            time_later(text, found.end())
        };
        let hour = later.map_or(
            if has_time { number(&found, 4) } else { 0.0 },
            |(hour, _)| hour,
        );
        let minute = later.map_or(
            found.get(5).map_or(0.0, |_| number(&found, 5)),
            |(_, minute)| minute,
        );
        let rolls = hour == 24.0 && minute == 0.0;
        if hour > 24.0 || (hour == 24.0 && minute != 0.0) || minute > 59.0 {
            continue;
        }
        let years = if has_year {
            let raw = number(&found, 3);
            vec![if raw < 100.0 { 2000.0 + raw } else { raw }]
        } else {
            // Ano do calendário de SP, e o anterior primeiro: "31/12" num post
            // de janeiro é o dezembro que passou.
            let current = sp_parts(ref_ms)?.year as f64;
            vec![current - 1.0, current, current + 1.0]
        };
        for year in years {
            let Some(source) = calendar_day(year, month, day) else {
                continue;
            };
            let Some(ms) = sp_instant(source, rolls, hour, minute)? else {
                continue;
            };
            if !has_year && ms < ref_ms - THIRTY_DAYS_MS {
                continue;
            }
            return Ok(Some(ParsedKickoff {
                ms,
                date_only: !has_time && later.is_none(),
            }));
        }
    }
    parse_relative(text, ref_ms)
}

/// O dia relativo à referência no calendário de São Paulo; o dia da semana é
/// o próximo, contando o de hoje.
fn parse_relative(text: &str, ref_ms: f64) -> Result<Option<ParsedKickoff>, DateError> {
    let Some(found) = relative_day_time().exec(text) else {
        return Ok(None);
    };
    let Some(word) = found.get(1).filter(|word| !word.is_empty()) else {
        return Ok(None);
    };
    let today = sp_parts(ref_ms)?;
    let word = strip_word_accents(&word.to_lowercase());
    let days_ahead = match word.as_str() {
        "hoje" => 0,
        "amanha" => 1,
        other => {
            let index = WEEKDAYS
                .iter()
                .position(|day| *day == other)
                .map_or(-1, |i| i as i64);
            (index - today.weekday + 7) % 7
        }
    };
    let minute = found
        .get(3)
        .or_else(|| found.get(4))
        .map_or(0.0, |digits| digits.parse().unwrap_or(f64::NAN));
    let ms = sp_to_utc(
        today.year as f64,
        today.month0 as f64 + 1.0,
        (today.day + days_ahead) as f64,
        number(&found, 2),
        minute,
    );
    Ok(Some(ParsedKickoff {
        ms,
        date_only: false,
    }))
}

/// `normalize("NFD").replace(/\p{Diacritic}/gu, "")` para as letras que o
/// regex do dia relativo casa: só `á`, `ã` e `ç` levam acento ali.
fn strip_word_accents(word: &str) -> String {
    word.chars()
        .map(|c| match c {
            'á' | 'ã' => 'a',
            'ç' => 'c',
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-09-23 12:00 UTC (quarta-feira, 09:00 em São Paulo).
    const REF: f64 = 1_790_164_800_000.0;

    fn iso(text: &str) -> Option<(String, bool)> {
        parse_br_kickoff(text, REF)
            .ok()
            .flatten()
            .and_then(|parsed| date::to_iso_string(parsed.ms).map(|iso| (iso, parsed.date_only)))
    }

    #[test]
    fn datas_do_post() {
        assert_eq!(
            iso("27/09 16:00"),
            Some(("2026-09-27T19:00:00.000Z".to_owned(), false))
        );
        assert_eq!(
            iso("📅 27/09 ⏰ 21h30"),
            Some(("2026-09-28T00:30:00.000Z".to_owned(), false))
        );
        assert_eq!(
            iso("Over 2.5 às 20h\n28/09"),
            Some(("2026-09-28T03:00:00.000Z".to_owned(), true))
        );
        assert_eq!(
            iso("2026-08-02 às 20h"),
            Some(("2026-08-02T23:00:00.000Z".to_owned(), false))
        );
        assert_eq!(
            iso("2026-09-27T16:00Z"),
            Some(("2026-09-27T16:00:00.000Z".to_owned(), false))
        );
        assert_eq!(
            iso("11 Sep 13:30"),
            Some(("2026-09-11T16:30:00.000Z".to_owned(), false))
        );
        assert_eq!(
            iso("hoje 21:30"),
            Some(("2026-09-24T00:30:00.000Z".to_owned(), false))
        );
        assert_eq!(
            iso("sábado 16:00"),
            Some(("2026-09-26T19:00:00.000Z".to_owned(), false))
        );
        assert_eq!(iso("Confiança 5/5"), None);
        assert_eq!(iso("Odd 2.11 - 20h"), None);
    }

    #[test]
    fn referencia_invalida_so_quando_usada() {
        assert!(parse_br_kickoff("27/09", f64::NAN).is_err());
        assert!(parse_br_kickoff("27/09/2026 16:00", f64::NAN).is_ok());
    }
}

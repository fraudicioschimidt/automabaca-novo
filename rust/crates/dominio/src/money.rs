//! Aritmética de dinheiro, portada de `src/domain/money.ts`. Invariante de
//! integridade financeira do Blueprint: somas e produtos em inteiro escalado
//! (10^casas), sem drift de ponto flutuante, e um arredondamento só, para
//! longe de zero, como o `numeric` do PostgreSQL.
//!
//! O TypeScript fazia isso em BigInt; aqui é inteiro de precisão arbitrária
//! (`num-bigint`), para dar o mesmo resultado em qualquer magnitude, e as
//! mensagens de erro são as do TS, palavra por palavra. A conversão do valor
//! do banco (`toNumber`) e o seletor do `sumMoneyBy` ficam na casca TS.

use crate::js;
use num_bigint::BigInt;
use num_traits::{Signed, ToPrimitive, Zero};

/// Erro de dinheiro; o texto é a mensagem do TypeScript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyError(pub String);

fn error(message: String) -> MoneyError {
    MoneyError(message)
}

/// `10 ** decimals` para as casas válidas (0 a 18), exato em f64.
fn factor(decimals: u32) -> f64 {
    const POWERS: [f64; 19] = [
        1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
        1e17, 1e18,
    ];
    POWERS[decimals as usize]
}

fn pow10(exponent: u32) -> BigInt {
    num_traits::pow(BigInt::from(10u8), exponent as usize)
}

/// As casas precisam ser inteiro de 0 a 18.
fn assert_decimals(decimals: f64) -> Result<u32, MoneyError> {
    if decimals.fract() != 0.0 || !(0.0..=18.0).contains(&decimals) {
        return Err(error(format!(
            "Precisão decimal inválida ({})",
            js::number_to_string(decimals)
        )));
    }
    Ok(decimals as u32)
}

/// O `number` em inteiro escalado a partir da representação decimal curta
/// dele (`Math.abs(value).toString()`, com o expoente), arredondando o
/// empate para longe de zero. `Math.round(value * 10^d)` erra nos negativos
/// e no 1.005 do ponto flutuante.
fn to_scaled(value: f64, decimals: f64) -> Result<BigInt, MoneyError> {
    if !value.is_finite() {
        return Err(error(format!(
            "Valor não-finito ({})",
            js::number_to_string(value)
        )));
    }
    let places = assert_decimals(decimals)?;
    let (negative, digits, exponent) = decompose(value);
    let digits = BigInt::from(digits);
    let shift = exponent + i64::from(places);
    let scaled = if shift >= 0 {
        digits * pow10(shift as u32)
    } else {
        let divisor = pow10((-shift) as u32);
        let quotient = &digits / &divisor;
        let remainder = &digits % &divisor;
        quotient + if remainder * 2 >= divisor { 1 } else { 0 }
    };
    Ok(if negative { -scaled } else { scaled })
}

/// `|value|` como `digits × 10^exponent`, pelos dígitos do `toString` do
/// JavaScript (que só muda onde põe a vírgula). Sem alocação: é o caminho
/// quente das somas.
fn decompose(value: f64) -> (bool, u128, i64) {
    let text = js::shortest_exp(value.abs());
    let text = text.as_str();
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = whole
        .bytes()
        .chain(fraction.bytes())
        .fold(0u128, |total, digit| total * 10 + u128::from(digit - b'0'));
    (value < 0.0, digits, exponent - fraction.len() as i64)
}

// Caminho rápido em i128 para o dinheiro de verdade: o mesmo resultado do
// BigInt, que fica para quando a conta estoura (`None`).

fn pow10_small(exponent: i64) -> Option<i128> {
    10i128.checked_pow(u32::try_from(exponent).ok()?)
}

fn divide_small(value: i128, divisor: i128) -> Option<i128> {
    let absolute = value.checked_abs()?;
    let (quotient, remainder) = (absolute / divisor, absolute % divisor);
    // `remainder * 2 >= divisor` sem estourar.
    let rounded = quotient + i128::from(remainder >= divisor - remainder);
    Some(if value < 0 { -rounded } else { rounded })
}

fn to_scaled_small(value: f64, places: u32) -> Option<i128> {
    if !value.is_finite() {
        return None;
    }
    let (negative, digits, exponent) = decompose(value);
    let digits = i128::try_from(digits).ok()?;
    let shift = exponent + i64::from(places);
    let scaled = if shift >= 0 {
        digits.checked_mul(pow10_small(shift)?)?
    } else {
        // Divisor que nem cabe no i128 é mais que o dobro de qualquer `digits`.
        match pow10_small(-shift) {
            Some(divisor) => divide_small(digits, divisor)?,
            None => 0,
        }
    };
    Some(if negative { -scaled } else { scaled })
}

fn small_to_number(value: i128, factor: f64, context: &str) -> Result<f64, MoneyError> {
    const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;
    if value.abs() <= MAX_SAFE_INTEGER {
        Ok(value as f64 / factor)
    } else {
        Err(error(format!(
            "{context}: total fora da faixa numérica segura"
        )))
    }
}

/// O inteiro escalado de volta a `number`, se cabe na faixa inteira segura.
fn scaled_to_number(value: &BigInt, factor: f64, context: &str) -> Result<f64, MoneyError> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    match value.to_i64() {
        Some(v) if v.abs() <= MAX_SAFE_INTEGER => Ok(v as f64 / factor),
        _ => Err(error(format!(
            "{context}: total fora da faixa numérica segura"
        ))),
    }
}

/// `value / divisor` arredondado ao inteiro, empate para longe de zero.
pub fn divide_round_half_away(value: &BigInt, divisor: &BigInt) -> Result<BigInt, MoneyError> {
    if !divisor.is_positive() {
        return Err(error(
            "divideRoundHalfAway: divisor deve ser estritamente positivo".to_owned(),
        ));
    }
    let absolute = value.abs();
    let quotient = &absolute / divisor;
    let remainder = &absolute % divisor;
    let rounded: BigInt = quotient + if remainder * 2 >= *divisor { 1 } else { 0 };
    Ok(if value.is_negative() {
        -rounded
    } else {
        rounded
    })
}

/// `divideRoundHalfAway` para quem tem o inteiro em texto decimal (a ponte:
/// o BigInt do JavaScript atravessa como `toString()`).
pub fn divide_round_half_away_text(value: &str, divisor: &str) -> Result<String, MoneyError> {
    let parse = |text: &str| {
        text.parse::<BigInt>()
            .map_err(|_| error(format!("divideRoundHalfAway: inteiro inválido ({text})")))
    };
    Ok(divide_round_half_away(&parse(value)?, &parse(divisor)?)?.to_string())
}

/// Soma N valores monetários sem erro de ponto flutuante.
pub fn sum_money_decimal(values: &[f64], decimals: f64) -> Result<f64, MoneyError> {
    sum_scaled(values, decimals, "sumMoneyDecimal", |v| {
        format!(
            "sumMoneyDecimal: valor não-finito ({})",
            js::number_to_string(v)
        )
    })
}

/// `sumMoneyBy` com os valores que o seletor devolveu.
pub fn sum_money_by(values: &[f64], decimals: f64) -> Result<f64, MoneyError> {
    sum_scaled(values, decimals, "sumMoneyBy", |v| {
        format!(
            "sumMoneyBy: seletor retornou valor não-finito ({})",
            js::number_to_string(v)
        )
    })
}

fn sum_scaled(
    values: &[f64],
    decimals: f64,
    context: &str,
    not_finite: impl Fn(f64) -> String,
) -> Result<f64, MoneyError> {
    // Precisão inválida explode SEMPRE, inclusive com a lista vazia.
    let places = assert_decimals(decimals)?;
    if values.is_empty() {
        return Ok(0.0);
    }
    let mut total = BigInt::zero();
    for &value in values {
        if !value.is_finite() {
            return Err(error(not_finite(value)));
        }
        total += to_scaled(value, decimals)?;
    }
    scaled_to_number(&total, factor(places), context)
}

/// Soma corrente sem drift: o acumulado a cada valor somado (curvas de PnL).
pub struct MoneyAccumulator {
    decimals: f64,
    factor: f64,
    total: BigInt,
}

impl MoneyAccumulator {
    pub fn new(decimals: f64) -> Result<Self, MoneyError> {
        let places = assert_decimals(decimals)?;
        Ok(Self {
            decimals,
            factor: factor(places),
            total: BigInt::zero(),
        })
    }

    /// Soma `value` e devolve o acumulado. O total muda mesmo quando o
    /// acumulado sai da faixa segura, como no TypeScript.
    pub fn add(&mut self, value: f64) -> Result<f64, MoneyError> {
        if !value.is_finite() {
            return Err(error(format!(
                "Acumulador monetário recebeu valor não-finito ({})",
                js::number_to_string(value)
            )));
        }
        self.total += to_scaled(value, self.decimals)?;
        self.value()
    }

    pub fn value(&self) -> Result<f64, MoneyError> {
        scaled_to_number(&self.total, self.factor, "Acumulador monetário")
    }
}

/// Arredondamento decimal correto ("1.005" com 2 casas dá 1.01).
pub fn round_money(value: f64, decimals: f64) -> Result<f64, MoneyError> {
    let small = assert_decimals(decimals)
        .ok()
        .and_then(|places| Some((to_scaled_small(value, places)?, places)));
    let rounded = match small {
        Some((scaled, places)) => small_to_number(scaled, factor(places), "roundMoney"),
        // As casas já foram validadas pelo `to_scaled`.
        None => to_scaled(value, decimals)
            .and_then(|scaled| scaled_to_number(&scaled, factor(decimals as u32), "roundMoney")),
    };
    // O prefixo é do TS, que o põe também sobre o erro de faixa ("roundMoney:
    // roundMoney: total fora…").
    rounded.map_err(|MoneyError(message)| error(format!("roundMoney: {message}")))
}

/// As escalas de `multiplyMoneyDecimal`, já com os padrões da casca TS.
#[derive(Debug, Clone, Copy)]
pub struct MultiplyOptions {
    pub decimals: f64,
    pub multiplier_decimals: f64,
    pub divisor: f64,
    pub divisor_decimals: f64,
    pub result_decimals: f64,
}

/// Dinheiro × fator decimal sem a operação em IEEE-754: os operandos
/// conservam a escala e o arredondamento é um só, na saída.
pub fn multiply_money_decimal(
    value: f64,
    multiplier: f64,
    options: MultiplyOptions,
) -> Result<f64, MoneyError> {
    let decimals = assert_decimals(options.decimals)?;
    let multiplier_decimals = assert_decimals(options.multiplier_decimals)?;
    let result_decimals = assert_decimals(options.result_decimals)?;
    let divisor_decimals = assert_decimals(options.divisor_decimals)?;
    let divisor = options.divisor;
    let max_safe = 9_007_199_254_740_991.0;
    let safe_integer = divisor.fract() == 0.0 && divisor.abs() <= max_safe;
    if !divisor.is_finite() || divisor <= 0.0 || (divisor_decimals == 0 && !safe_integer) {
        return Err(error(format!(
            "multiplyMoneyDecimal: divisor inválido ({})",
            js::number_to_string(divisor)
        )));
    }
    let scales = [
        decimals,
        multiplier_decimals,
        divisor_decimals,
        result_decimals,
    ];
    if let Some(scaled) = multiply_small(value, multiplier, divisor, scales) {
        return small_to_number(scaled, factor(result_decimals), "multiplyMoneyDecimal");
    }
    let scaled = multiply_big(value, multiplier, divisor, scales)?;
    scaled_to_number(&scaled, factor(result_decimals), "multiplyMoneyDecimal")
}

/// `multiply_money_decimal` em precisão arbitrária, com os erros do TS.
fn multiply_big(
    value: f64,
    multiplier: f64,
    divisor: f64,
    scales: [u32; 4],
) -> Result<BigInt, MoneyError> {
    let [
        decimals,
        multiplier_decimals,
        divisor_decimals,
        result_decimals,
    ] = scales;
    let scaled_divisor = to_scaled(divisor, f64::from(divisor_decimals))?;
    if !scaled_divisor.is_positive() {
        return Err(error(
            "multiplyMoneyDecimal: divisor arredondado a zero".to_owned(),
        ));
    }
    let product = to_scaled(value, f64::from(decimals))?
        * to_scaled(multiplier, f64::from(multiplier_decimals))?;
    let shift = i64::from(result_decimals) + i64::from(divisor_decimals)
        - i64::from(decimals + multiplier_decimals);
    let numerator = if shift > 0 {
        product * pow10(shift as u32)
    } else {
        product
    };
    let denominator = if shift < 0 {
        scaled_divisor * pow10((-shift) as u32)
    } else {
        scaled_divisor
    };
    divide_round_half_away(&numerator, &denominator)
}

/// `multiply_money_decimal` em i128; `None` quando algum passo estoura ou
/// quando há erro a relatar, que o caminho em BigInt descreve.
fn multiply_small(value: f64, multiplier: f64, divisor: f64, scales: [u32; 4]) -> Option<i128> {
    let [
        decimals,
        multiplier_decimals,
        divisor_decimals,
        result_decimals,
    ] = scales;
    let scaled_divisor = to_scaled_small(divisor, divisor_decimals).filter(|d| *d > 0)?;
    let product = to_scaled_small(value, decimals)?
        .checked_mul(to_scaled_small(multiplier, multiplier_decimals)?)?;
    let shift = i64::from(result_decimals) + i64::from(divisor_decimals)
        - i64::from(decimals + multiplier_decimals);
    let numerator = if shift > 0 {
        product.checked_mul(pow10_small(shift)?)?
    } else {
        product
    };
    let denominator = if shift < 0 {
        scaled_divisor.checked_mul(pow10_small(-shift)?)?
    } else {
        scaled_divisor
    };
    divide_small(numerator, denominator)
}

const DEFAULT_OPTIONS: MultiplyOptions = MultiplyOptions {
    decimals: 6.0,
    multiplier_decimals: 4.0,
    divisor: 1.0,
    divisor_decimals: 0.0,
    result_decimals: 6.0,
};

/// Valor monetário ponderado por uma porcentagem.
pub fn money_by_percent(value: f64, percent: f64) -> Result<f64, MoneyError> {
    multiply_money_decimal(
        value,
        percent,
        MultiplyOptions {
            multiplier_decimals: 6.0,
            divisor: 100.0,
            ..DEFAULT_OPTIONS
        },
    )
}

/// Unidades (seis casas) × valor da unidade (R$, duas casas), ao centavo.
pub fn units_to_brl(units: f64, valor_unidade: f64) -> Result<f64, MoneyError> {
    multiply_money_decimal(
        units,
        valor_unidade,
        MultiplyOptions {
            multiplier_decimals: 2.0,
            result_decimals: 2.0,
            ..DEFAULT_OPTIONS
        },
    )
}

/// Unidades em reais com seis casas, como stake e lucro no banco.
pub fn units_to_reais(units: f64, unit_value: f64) -> Result<f64, MoneyError> {
    multiply_money_decimal(
        units,
        unit_value,
        MultiplyOptions {
            multiplier_decimals: 2.0,
            ..DEFAULT_OPTIONS
        },
    )
}

/// Soma de Kahan, em ponto flutuante de propósito.
pub fn kahan_sum(values: &[f64]) -> Result<f64, MoneyError> {
    let (mut sum, mut compensation) = (0.0_f64, 0.0_f64);
    for &x in values {
        if !x.is_finite() {
            return Err(error(format!(
                "kahanSum: valor não-finito recebido ({})",
                js::number_to_string(x)
            )));
        }
        let y = x - compensation;
        let t = sum + y;
        compensation = (t - sum) - y;
        sum = t;
    }
    Ok(sum)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message<T: std::fmt::Debug>(result: Result<T, MoneyError>) -> String {
        result.err().map(|e| e.0).unwrap_or_default()
    }

    #[test]
    fn somas_sem_drift() {
        assert_eq!(sum_money_decimal(&[0.1, 0.2], 6.0), Ok(0.3));
        assert_eq!(sum_money_decimal(&vec![0.01; 10_000], 2.0), Ok(100.0));
        assert_eq!(sum_money_decimal(&[], 6.0), Ok(0.0));
        assert_eq!(sum_money_decimal(&[-0.005], 2.0), Ok(-0.01));
        assert_eq!(sum_money_decimal(&[0.005, -0.005], 2.0), Ok(0.0));
        assert_eq!(
            sum_money_decimal(&[9_007_199_254_740_991.0], 0.0),
            Ok(9_007_199_254_740_991.0)
        );
        assert_eq!(
            message(sum_money_decimal(&[], 25.0)),
            "Precisão decimal inválida (25)"
        );
        assert_eq!(
            message(sum_money_decimal(&[1.5, f64::NAN], 6.0)),
            "sumMoneyDecimal: valor não-finito (NaN)"
        );
        assert_eq!(
            message(sum_money_decimal(&[9_007_199_254_740_991.0], 6.0)),
            "sumMoneyDecimal: total fora da faixa numérica segura"
        );
        // Termos enormes que se cancelam: a precisão arbitrária acerta, como o BigInt.
        assert_eq!(sum_money_decimal(&[1e300, -1e300, 1.5], 6.0), Ok(1.5));
    }

    #[test]
    fn arredondamento_e_produto() {
        assert_eq!(round_money(1.005, 2.0), Ok(1.01));
        assert_eq!(round_money(-1.005, 2.0), Ok(-1.01));
        assert_eq!(round_money(10.123_456_7, 6.0), Ok(10.123_457));
        assert_eq!(
            message(round_money(f64::NAN, 2.0)),
            "roundMoney: Valor não-finito (NaN)"
        );
        assert_eq!(
            message(round_money(1e300, 6.0)),
            "roundMoney: roundMoney: total fora da faixa numérica segura"
        );
        // O mesmo prefixo duplo do TS quando a conta cabe no i128.
        assert_eq!(
            message(round_money(9_007_199_254_740_992.0, 0.0)),
            "roundMoney: roundMoney: total fora da faixa numérica segura"
        );
        assert_eq!(units_to_brl(1.234_567, 100.0), Ok(123.46));
        assert_eq!(money_by_percent(200.0, 12.5), Ok(25.0));
        let opts = MultiplyOptions {
            divisor: 2.0,
            ..DEFAULT_OPTIONS
        };
        assert_eq!(multiply_money_decimal(1.0, 0.85, opts), Ok(0.425));
        let bad = MultiplyOptions {
            divisor: 0.0,
            ..DEFAULT_OPTIONS
        };
        assert_eq!(
            message(multiply_money_decimal(1.0, 1.0, bad)),
            "multiplyMoneyDecimal: divisor inválido (0)"
        );
        // Produto acima de i128 que volta à faixa pela divisão.
        let big = MultiplyOptions {
            decimals: 18.0,
            multiplier_decimals: 18.0,
            result_decimals: 2.0,
            ..DEFAULT_OPTIONS
        };
        assert_eq!(multiply_money_decimal(1000.0, 1000.0, big), Ok(1_000_000.0));
        // 1000000000000000.2 vale …0.25: o `toString` do JS dá …0.2 (o par).
        assert_eq!(
            money_by_percent(0.0005, 1_000_000_000_000_000.2),
            Ok(5_000_000_000.000_001)
        );
    }

    #[test]
    fn caminho_rapido_igual_ao_bigint() {
        let to_small = |big: BigInt| big.to_i128();
        for (value, multiplier) in [
            (1.005, 1.87),
            (-2.675, 0.5),
            (123_456.785, -3.17),
            (1e20, 1e17),
            (9.999_999_999_999_999e20, 1.7e16),
            (-1.2e19, 1.4e19),
            (0.000_000_5, 1e21),
            (5e-324, 1e300),
        ] {
            for scales in [
                [6, 4, 0, 6],
                [18, 18, 0, 2],
                [6, 6, 0, 6],
                [0, 0, 3, 18],
                [2, 2, 18, 0],
            ] {
                for divisor in [1.0, 2.0, 100.0, 0.001, 1e15] {
                    let big = multiply_big(value, multiplier, divisor, scales).ok();
                    if let Some(small) = multiply_small(value, multiplier, divisor, scales) {
                        let expected = big.and_then(to_small);
                        assert_eq!(
                            Some(small),
                            expected,
                            "{value} {multiplier} {divisor} {scales:?}"
                        );
                    }
                }
            }
            for places in 0..=18 {
                let big = to_scaled(value, f64::from(places)).ok();
                if let Some(small) = to_scaled_small(value, places) {
                    assert_eq!(Some(small), big.and_then(to_small), "{value} {places}");
                }
            }
        }
    }

    #[test]
    fn acumulador_e_kahan() {
        let mut acc = MoneyAccumulator::new(2.0).unwrap_or_else(|_| unreachable!());
        assert_eq!(acc.add(0.1), Ok(0.1));
        assert_eq!(acc.add(0.2), Ok(0.3));
        assert_eq!(
            message(acc.add(f64::INFINITY)),
            "Acumulador monetário recebeu valor não-finito (Infinity)"
        );
        assert!(MoneyAccumulator::new(-1.0).is_err());
        assert_eq!(
            message(kahan_sum(&[1.0, f64::NAN])),
            "kahanSum: valor não-finito recebido (NaN)"
        );
        assert_eq!(
            message(divide_round_half_away(&BigInt::from(1), &BigInt::from(0))),
            "divideRoundHalfAway: divisor deve ser estritamente positivo"
        );
        assert_eq!(
            divide_round_half_away(&BigInt::from(-5), &BigInt::from(2)),
            Ok(BigInt::from(-3))
        );
    }
}

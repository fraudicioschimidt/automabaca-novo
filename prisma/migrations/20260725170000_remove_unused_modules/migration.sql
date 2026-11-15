-- Remoção de módulos sem uso real (decisão do dono em 2026-07-25, com base em
-- medição: zero registros em produção desde o início do projeto).
--   * passkeys/WebAuthn e TOTP: segundo fator nunca ativado; o login segue com
--     senha + lockout por (usuário, IP) + sessão por dispositivo.
--   * visualizações salvas: nenhuma criada.
DROP TABLE IF EXISTS "auth_webauthn_challenges";
DROP TABLE IF EXISTS "auth_passkey_credentials";
DROP TABLE IF EXISTS "auth_totp_credentials";
DROP TABLE IF EXISTS "saved_views";
DROP TYPE IF EXISTS "WebAuthnChallengePurpose";

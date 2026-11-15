import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "typescript-eslint";
import reactX from "eslint-plugin-react-x";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y-x";
import importX from "eslint-plugin-import-x";
import globals from "globals";

// Link interno do painel é `next/link`: nada intercepta clique em `<a>`, que
// recarregaria a página inteira. A regra do Next só reconhece `href` literal
// de rota existente; esta pega também o `href` montado ('/aposta?id=' + id,
// template). Ficam `<a>` âncora, `/api/` e externo.
const LINK_INTERNO = [
  "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='href'] > Literal[value=/^\\x2F(?!\\x2F|api\\x2F)/]",
  "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='href'] > JSXExpressionContainer Literal[value=/^\\x2F(?!\\x2F|api\\x2F)/]",
  "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='href'] > JSXExpressionContainer TemplateElement[value.raw=/^\\x2F(?!\\x2F|api\\x2F)/]",
].map((selector) => ({
  selector,
  message: "Link interno do painel é <Link> de next/link: <a> recarrega a página inteira.",
}));

// O fixture de demonstração só entra pelo `mockFixture` de app/(painel)/_mock.ts,
// que o guarda com `allowMockQuery`: fora dele, um `import()` do mock serviria
// dado fake no painel de produção.
// A aposta capturada (canal, conserto pela DM, DM) grava pelo registro único
// da captura, que monta a evidência igual para todas. Só ele e a aposta à mão
// do painel chamam registerBet direto; os testes podem. O único módulo
// `register` é o de src/services/bets, e o padrão pega o alias e os caminhos
// relativos (`./register` dentro da pasta dele). No flat config, a regra do
// último bloco que casa com o arquivo substitui a dos anteriores: todo bloco
// que restringe imports repete este padrão.
const REGISTER_BET_RESTRICTION = {
  regex: "(?:^|/)register$",
  importNames: ["registerBet"],
  message: "Aposta capturada grava por registerCapturedBet (src/services/capture/register-captured-bet.ts).",
};

const MOCK_SO_PELO_GUARDA = [{
  selector: "ImportExpression[source.value=/\\x2F_design\\x2Fmock\\x2F/]:not(CallExpression[callee.name='mockFixture'] > ArrowFunctionExpression > ImportExpression)",
  message: "Mock só entra por mockFixture(sp.mock, () => import(...)), de app/(painel)/_mock.ts.",
}];

const eslintConfig = [
  // Plugins diretos: o preset eslint-config-next ainda depende de plugins que
  // só aceitam ESLint 9.
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "@next/next": nextPlugin,
      "react-x": reactX,
      "react-hooks": reactHooks,
      "jsx-a11y-x": jsxA11y,
      "import-x": importX,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...Object.fromEntries(Object.entries(reactX.configs["recommended-typescript"].rules)
        .filter(([name]) => !(name.replace("react-x/", "react-hooks/") in reactHooks.configs.recommended.rules))),
      ...reactHooks.configs.recommended.rules,
      "react-x/no-array-index-key": "off",
      "import-x/no-anonymous-default-export": "warn",
      "jsx-a11y-x/alt-text": ["warn", { elements: ["img"], img: ["Image"] }],
      "jsx-a11y-x/aria-props": "warn",
      "jsx-a11y-x/aria-proptypes": "warn",
      "jsx-a11y-x/aria-unsupported-elements": "warn",
      "jsx-a11y-x/role-has-required-aria-props": "warn",
      "jsx-a11y-x/role-supports-aria-props": "warn",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // `typeof import("...")` fica liberado: os testes o usam para tipar mocks dinâmicos.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
      "prefer-const": "error",
      "no-var": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-eval": "error",
      // `void promise` engole a rejeição; trate o erro ou aguarde.
      "no-void": ["error", { allowAsStatement: false }],
    },
  },
  {
    // Promise esquecida (sem await/.catch) é erro. Exige lint com tipos.
    files: ["src/**/*.ts", "app/**/*.{ts,tsx}", "tests/**/*.ts", "prisma/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["src/**/*.ts", "app/**/*.{ts,tsx}", "scripts/**/*.ts"],
    ignores: [
      "src/services/capture/register-captured-bet.ts",
      "src/services/bets/manual.ts",
      "src/services/bets/register.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [REGISTER_BET_RESTRICTION] }],
    },
  },
  {
    // DesignScreen.tsx usa o padrão "mount-gate" (setMounted no effect).
    files: ["app/_design/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Import estático (inclusive de tipo) puxaria o mock para o grafo do módulo;
    // o tipo de produção vem do adaptador, e o mock é que se ajusta a ele.
    files: ["app/**/*.{ts,tsx}"],
    ignores: ["app/_design/mock/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/_design/mock/*", "**/_design/mock", "./mock/*", "../mock/*", "../../mock/*"],
          message: "Mock não entra por import estático: use mockFixture(sp.mock, () => import(...)).",
        }, REGISTER_BET_RESTRICTION],
      }],
      "no-restricted-syntax": ["error", ...MOCK_SO_PELO_GUARDA],
    },
  },
  {
    files: ["app/**/*.tsx"],
    ignores: ["app/_design/mock/**"],
    rules: {
      "no-restricted-syntax": ["error", ...LINK_INTERNO, ...MOCK_SO_PELO_GUARDA],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "dist/**",
      "playwright-report/**",
      "test-results/**",
      "reports/**",
      "coverage/**",
      "src/generated/**",
      "next-env.d.ts",
      "scripts/.tmp-*",
      ".claude/worktrees/**",
    ],
  },
];

export default eslintConfig;

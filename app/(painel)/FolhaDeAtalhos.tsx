"use client";

import { ATALHOS_GERAIS, ATALHOS_POR_TELA, NAV } from "@/app/_design/lib/atalhos";
import styles from "./CommandPalette.module.css";

/**
 * O corpo da folha do `?`. Módulo próprio para o portão
 * `tests/painel/atalhos.test.tsx` poder renderizá-lo sem arrastar a server
 * action de busca (e o Prisma atrás dela): a folha é apresentação pura, e um
 * portão de teclado que precisa de banco falha pelo motivo errado.
 */
export function FolhaDeAtalhos() {
  return (
    <div className={styles.content}>
      <section className={styles.section}>
        <div className={styles.label}>Geral</div>
        {ATALHOS_GERAIS.map((atalho) => (
          <div key={atalho.descricao} className={styles.item}>
            <span className={styles.itemText}><span className={styles.title}>{atalho.descricao}</span></span>
            <span className={styles.shortcut}>{atalho.teclas.join(" · ")}</span>
          </div>
        ))}
      </section>
      <section className={styles.section}>
        <div className={styles.label}>Ir para</div>
        {/* Direto de NAV: a lista NÃO pode divergir do atalho real. */}
        {NAV.map((item) => (
          <div key={item.id} className={styles.item}>
            <span className={styles.itemText}>
              <span className={styles.title}>{item.title}</span>
              <span className={styles.detail}>{item.detail}</span>
            </span>
            <span className={styles.shortcut}>{item.shortcut}</span>
          </div>
        ))}
      </section>
      {/* Atalhos que valem só numa tela. O escopo é o rótulo da seção: a folha é
          global e lista tudo (é assim que se descobre a tecla), mas dizer ONDE
          ela vale evita anunciar gesto que não funciona onde você está. */}
      {ATALHOS_POR_TELA.map((grupo) => (
        <section key={grupo.escopo} className={styles.section}>
          <div className={styles.label}>{grupo.escopo}</div>
          {grupo.entradas.map((atalho) => (
            <div key={atalho.descricao} className={styles.item}>
              <span className={styles.itemText}><span className={styles.title}>{atalho.descricao}</span></span>
              <span className={styles.shortcut}>{atalho.teclas.join(" · ")}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

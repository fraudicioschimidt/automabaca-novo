// Sidebar desktop + navegação compacta (gaveta) para telas pequenas.
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChromeUserContext } from "./chrome-context";
import { APP_COMPACT_BREAKPOINT } from "./layout";
import styles from "./AppSidebar.module.css";
import { ICONS, Icon } from "./kit/icons";
import { toast } from "./toast";
import { useDesign } from "./kit/context";
import { Cap } from "./kit/primitives";
import type { CssVarsStyle } from "./kit/css-vars";

/** Rótulo e destino de cada entrada da navegação. */
type Entrada = readonly [label: string, href: string];

// A sidebar não anuncia a tecla do destino: os atalhos ficam só na folha do
// `?`. `tests/painel/atalhos.test.tsx` exige que todo destino daqui exista em `lib/atalhos`.
const NAV1: readonly Entrada[] = [['Dashboard', '/'], ['Tipsters', '/tipsters'], ['Contas', '/contas'], ['Ferramentas', '/ferramentas']];
const NAV2: readonly Entrada[] = [['Operacoes', '/operacoes'], ['Monitoramento', '/monitoramento'], ['Config', '/config']];
const LABEL: Record<string, string> = { Operacoes: 'Operações' };
const navLabel = (label: string) => LABEL[label] || label;

async function logout() {
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Não foi possível encerrar a sessão com segurança. Tente novamente.');
    // Navegação completa de propósito: descarta o cache do roteador, que
    // guarda as páginas renderizadas para a sessão que acabou de sair.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = '/login';
  } catch (error) {
    toast((error instanceof Error && error.message) || 'Falha ao encerrar a sessão.', 'warn');
  }
}

function NavItem({ label, href, active, onNavigate, mobile = false }: {
  label: string;
  href: string;
  active: string;
  onNavigate: () => void;
  mobile?: boolean;
}) {
  const isActive = label === active;
  const inner = (
    <div className={`${styles.navItem} ${mobile ? styles.navMobile : ''} ${isActive ? styles.navActive : ''}`}>
      {navLabel(label)}
      {isActive ? <span aria-hidden="true" className={styles.activeDot} /> : null}
    </div>
  );
  // Sem prefetch: toda action que revalida esvazia o cache do roteador, e cada
  // link visível voltava a buscar a própria página (uma requisição por link a
  // cada Salvar). As telas são dinâmicas; o prefetch só trazia o esqueleto.
  return href && !isActive
    ? <Link href={href} prefetch={false} onClick={onNavigate} className={styles.navLink}>{inner}</Link>
    : <div aria-current={isActive ? 'page' : undefined}>{inner}</div>;
}

function Brand({ active, compact = false }: { active: string; compact?: boolean }) {
  return (
    <div className={styles.brand}>
      <div className={styles.brandMark}>
        <Icon aria-hidden="true" d={ICONS.logo} s={17} w={1.9} />
      </div>
      <div data-brand-wordmark="" role="img" aria-label="AutomaBACA" className={styles.wordmark}>
        <span aria-hidden="true">Automa<span className={styles.wordmarkAccent}>BACA</span></span>
      </div>
      {compact ? <span className={styles.compactLabel}>· {active}</span> : null}
    </div>
  );
}

function ThemeButton({ mobile = false }: { mobile?: boolean }) {
  const { mode, setMode } = useDesign();
  return (
    <button type="button" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
      aria-label={mode === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'} title="Tema"
      className={`${styles.iconButton} ${styles.themeButton} ${mobile ? styles.iconButtonMobile : ''}`}>
      <Icon aria-hidden="true" d={mode === 'dark' ? ICONS.sun : ICONS.moon} s={17} />
    </button>
  );
}

function LogoutButton({ mobile = false }: { mobile?: boolean }) {
  return (
    <button type="button" onClick={logout} aria-label="Sair" title="Sair"
      className={`${styles.iconButton} ${styles.logoutButton} ${mobile ? styles.iconButtonMobile : ''}`}>
      <Icon aria-hidden="true" d={ICONS.logout} s={17} />
    </button>
  );
}

/** Rodapé com o usuário; no desktop, o nome abre um menu com tema e saída. */
function UserFooter({ userName, mobile = false }: { userName: string; mobile?: boolean }) {
  const { mode, setMode } = useDesign();
  const [userOpen, setUserOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!userOpen) return undefined;
    const close = (event: PointerEvent) => {
      if (!userMenuRef.current?.contains(event.target instanceof Node ? event.target : null)) setUserOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setUserOpen(false);
      userTriggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [userOpen]);

  return (
    <div className={styles.userFooter}>
      <div aria-hidden="true" className={styles.avatar}>
        {userName.charAt(0)}
      </div>
      {mobile ? (
        <div className={styles.userContent}>
          <div className={styles.userName}>{userName}</div>
          <div className={styles.userMeta}>Sessão autenticada</div>
        </div>
      ) : (
        <div ref={userMenuRef} className={styles.userMenuWrap}>
          <button ref={userTriggerRef} type="button" data-user-trigger="" aria-haspopup="menu" aria-expanded={userOpen}
            aria-controls="sidebar-user-menu"
            onClick={() => setUserOpen((open) => !open)}
            className={styles.userTrigger}>
            <span className={styles.userName}>{userName}</span>
            <span className={`${styles.chevron} ${userOpen ? styles.chevronOpen : ''}`}><Icon aria-hidden="true" d={ICONS.chevronDown} s={13} /></span>
          </button>
          {userOpen ? (
            <div id="sidebar-user-menu" role="menu" className={styles.userMenu}>
              <div className={styles.userMenuHead}>
                <div className={styles.userName}>{userName}</div>
                <div className={styles.userMeta}>Sessão autenticada</div>
              </div>
              <button type="button" role="menuitem" onClick={() => { setMode(mode === 'dark' ? 'light' : 'dark'); setUserOpen(false); }}
                className={styles.menuAction}>
                <Icon aria-hidden="true" d={mode === 'dark' ? ICONS.sun : ICONS.moon} s={17} />
                {mode === 'dark' ? 'Tema claro' : 'Tema escuro'}
              </button>
              <button type="button" role="menuitem" onClick={logout}
                className={`${styles.menuAction} ${styles.menuDanger}`}>
                <Icon aria-hidden="true" d={ICONS.logout} s={17} />Sair
              </button>
            </div>
          ) : null}
        </div>
      )}
      <ThemeButton mobile={mobile} />
      <LogoutButton mobile={mobile} />
    </div>
  );
}

export function AppSidebar({ active }: { active: string }) {
  const { T } = useDesign();
  const ctxUser = use(ChromeUserContext) || 'fabricio';
  const userName = ctxUser.charAt(0).toUpperCase() + ctxUser.slice(1);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const restoreMobileTriggerRef = useRef(true);
  const closeMobile = () => setMobileOpen(false);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const trigger = mobileTriggerRef.current;
    const previousOverflow = document.body.style.overflow;
    const compactMedia = window.matchMedia(`(max-width: ${APP_COMPACT_BREAKPOINT - 1}px)`);
    const onCompactChange = () => {
      if (compactMedia.matches) return;
      restoreMobileTriggerRef.current = false;
      setMobileOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    compactMedia.addEventListener('change', onCompactChange);
    requestAnimationFrame(() => drawerRef.current?.querySelector('button')?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      compactMedia.removeEventListener('change', onCompactChange);
      if (restoreMobileTriggerRef.current) trigger?.focus();
    };
  }, [mobileOpen]);

  const normalizedActive = active === 'Operações' ? 'Operacoes' : active;
  const themeVars: CssVarsStyle = {
    '--side-bg': T.sidebar, '--side-color': T.sidebarText, '--side-border': T.border,
    '--side-border-soft': T.borderSoft, '--side-surface': T.surface, '--side-surface-2': T.surface2,
    '--side-text': T.text, '--side-muted': T.textMuted, '--side-faint': T.textFaint,
    '--side-accent': T.accent, '--side-brand': T.brandAccent || T.accent, '--side-on-accent': T.accentText,
    // Os raios do tema são números: sem a unidade, o CSS descarta a variável.
    '--side-neg': T.neg, '--side-radius': `${T.radiusSm}px`, '--side-radius-md': `${T.radiusMd}px`,
    '--side-shadow': T.cardShadow, '--side-body': T.font.body, '--side-num': T.font.num,
  };

  return (
    <>
      <aside data-sidebar="" className={`app-sidebar-desktop ${styles.sidebar} ${styles.sticky}`} aria-label="Navegação principal" style={themeVars}>
        <div className={styles.brandPad}><Brand active={active} /></div>
        <nav aria-label="Painel" className={styles.nav}>
          {NAV1.map(([label, href]) => <NavItem key={href} label={label} href={href} active={normalizedActive} onNavigate={closeMobile} />)}
        </nav>
        <Cap style={{ padding: '22px 12px 8px' }}>Operação</Cap>
        <nav aria-label="Operação" className={styles.nav}>
          {NAV2.map(([label, href]) => <NavItem key={href} label={label} href={href} active={normalizedActive} onNavigate={closeMobile} />)}
        </nav>
        <UserFooter userName={userName} />
      </aside>

      <header className={`app-mobile-header ${styles.mobileHeader}`} style={themeVars}>
        <Brand compact active={active} />
        <button ref={mobileTriggerRef} type="button" onClick={() => { restoreMobileTriggerRef.current = true; setMobileOpen(true); }} aria-label="Abrir menu"
          aria-expanded={mobileOpen} aria-controls="mobile-navigation"
          className={styles.mobileMenuButton}>
          <Icon aria-hidden="true" d={ICONS.menu} s={20} w={1.8} />
        </button>
      </header>

      {mobileOpen ? (
        <div className={`app-mobile-layer ${styles.mobileLayer}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setMobileOpen(false); }} style={themeVars}>
          <aside id="mobile-navigation" ref={drawerRef} role="dialog" aria-modal="true" aria-label="Menu principal"
            className={styles.drawer}>
            <div className={styles.drawerHead}>
              <Brand active={active} />
              <button type="button" onClick={() => setMobileOpen(false)} aria-label="Fechar menu"
                className={styles.drawerClose}>
                <Icon aria-hidden="true" d={ICONS.close} s={18} />
              </button>
            </div>
            <nav aria-label="Painel" className={styles.nav}>
              {NAV1.map(([label, href]) => <NavItem key={href} label={label} href={href} active={normalizedActive} onNavigate={closeMobile} mobile />)}
            </nav>
            <Cap style={{ padding: '22px 12px 8px' }}>Operação</Cap>
            <nav aria-label="Operação" className={styles.nav}>
              {NAV2.map(([label, href]) => <NavItem key={href} label={label} href={href} active={normalizedActive} onNavigate={closeMobile} mobile />)}
            </nav>
            <UserFooter userName={userName} mobile />
          </aside>
        </div>
      ) : null}
    </>
  );
}

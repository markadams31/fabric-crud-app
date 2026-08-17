import {
  Badge,
  Button,
  FluentProvider,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  Caption1,
  Spinner,
  Subtitle2,
  Tab,
  TabList,
  Title3,
  createDarkTheme,
  createLightTheme,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
  type BrandVariants,
} from '@fluentui/react-components';
import {
  DatabaseRegular,
  LockClosedRegular,
  PersonCircleRegular,
  SignOutRegular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useState } from 'react';

import { ToastProvider } from './toast';

import { readable } from './db';
import { allEntities, type EntityView } from './entity';
import { EntityPage, NO_FILTERS, type Filters } from './EntityPage';
import { client, isEmbedded, isLocalBackend, resumeSession, signIn } from './rayfin';

/** The active instance and its display name, injected at build time — see
 *  vite.config.ts, which also substitutes the title into index.html. */
declare const __APP_INSTANCE__: string;
declare const __APP_TITLE__: string;

/**
 * What this app calls itself — derived in `instance.config.ts` so the app bar's
 * heading and the browser tab cannot disagree.
 *
 * Every instance used to show one hard-coded heading, so four different apps
 * were indistinguishable on screen. Embedded in the Fabric portal the heading
 * is dropped entirely — the host chrome already shows the item's name above
 * the frame, and repeating it just spends a line of a narrow pane. Same
 * reasoning as the account menu below.
 */
const APP_TITLE = __APP_TITLE__;

/**
 * Styles from Fluent's tokens rather than hand-picked values, so spacing,
 * colour and elevation follow the design system and both themes stay correct.
 */
const useStyles = makeStyles({
  // Paints the app's ground. NOT on FluentProvider — it also renders a portal
  // node for popups, so a full-height class there becomes an invisible overlay
  // that swallows every click. Background1 rather than 2: the Fabric portal's
  // content area is flat white with tables sitting directly on it, and the
  // grid card is deliberately chromeless to match (see EntityPage's `card`).
  app: { minHeight: '100vh', backgroundColor: tokens.colorNeutralBackground1 },
  /**
   * Standalone only. Embedded, the portal supplies the whole application
   * shell — a top bar naming the item, a nav rail, breadcrumbs, and a ground
   * colour that separates its chrome from our content — so this app is
   * deliberately a flat content pane and matches. Opened as a website nothing
   * supplies any of that, and the same flatness reads as unstyled: white
   * content on a white page with no figure/ground at all.
   *
   * The fix is a ground, not a width cap. Capping the page centred the
   * content but produced blank right margin while columns inside the grid
   * truncated (see `page` below, and CLAUDE.md's rejected designs). Painting
   * the ground instead lets the surface stay exactly as wide as the table
   * needs: the space beside it stops being empty page and becomes deliberate
   * margin around a defined card.
   */
  ground: { backgroundColor: tokens.colorNeutralBackground3 },
  /** The app bar this app has to draw itself once no host draws one. */
  appbar: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: '12px 24px',
  },
  /**
   * The working surface. `fit-content` so it hugs the grid rather than
   * stretching into the same emptiness the ground now explains, and
   * `max-width: 100%` so a window narrower than the table hands scrolling
   * back to the grid's own overflow rather than pushing the page sideways.
   */
  surface: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: '4px 16px 16px',
    width: 'fit-content',
    maxWidth: '100%',
  },
  // No max width. A fixed cap is the wrong instrument for a table: it produced
  // exactly the complaint it was meant to prevent — blank margin on the right
  // while columns inside the grid truncated — and every time the data grew,
  // the number had to grow with it (76rem, then 94rem). The grid governs its
  // own width instead: `fitWidths` spends spare room only on columns that are
  // actually clipping and never past what they need, so a very wide window
  // stops widening the table once nothing is cut off, rather than stretching
  // it across the screen.
  page: { padding: '24px 24px 48px' },
  head: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '12px',
    // `Title3 as="h1"` keeps the user agent's h1 margin — 0.67em, so ~16px above
    // and below at 24px type. As a flex item that margin becomes outer height,
    // which made a bar 105px tall to hold 32px of text (measured). Zeroing it
    // and dropping the bottom margin this header carried when it sat inside
    // `main` leaves 12 + 32 + 12.
    '> h1': { marginTop: 0, marginBottom: 0 },
  },
  logo: {
    fontSize: '26px',
    color: tokens.colorBrandForeground1,
    display: 'flex',
  },
  spacer: { flexGrow: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
  bar: { marginBottom: '12px' },
  lockIcon: { fontSize: '32px', color: tokens.colorNeutralForeground4 },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '6px',
    ...shorthands.padding('56px', '16px'),
    textAlign: 'center',
  },
});

/**
 * The Fabric portal's brand ramp, so the app looks native next to the host
 * that embeds it — Fluent's default `webLightTheme` is blue, the portal is
 * teal. The sixteen stops are the Fabric UX System's own (`brandFabric` in
 * @fabric-msft/theme 5.3.0, inlined rather than depended on), and the themes
 * derived from them reproduce the tokens measured on the live portal:
 * 80 is `colorBrandBackground`, 70 hover, 40 pressed.
 */
const brandFabric: BrandVariants = {
  10: '#001919',
  20: '#012826',
  30: '#01322E',
  40: '#033F38',
  50: '#054D43',
  60: '#0A5C50',
  70: '#0C695A',
  80: '#117865',
  90: '#1F937E',
  100: '#2AAC94',
  110: '#3ABB9F',
  120: '#52C7AA',
  130: '#78D3B9',
  140: '#9EE0CB',
  150: '#C0ECDD',
  160: '#E3F7EF',
};
const fabricLight = createLightTheme(brandFabric);
const fabricDark = createDarkTheme(brandFabric);

/**
 * Fabric hosts the app in an iframe and does not hand its theme across, so
 * follow the OS preference — which is what the portal itself defaults to.
 */
function useTheme() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark ? fabricDark : fabricLight;
}

/**
 * The current session, live. The SDK persists, refreshes and multi-tab-syncs
 * sessions itself and raises one change event for every transition — including
 * a sign-out or expiry in another tab — so subscribing is the whole job, and
 * no sign-in path needs to hand a user back to the UI.
 */
function useSession() {
  const [session, setSession] = useState(() => client.auth.getSession());
  useEffect(() => client.auth.onSessionChange(() => setSession(client.auth.getSession())), []);
  return session;
}

export default function App() {
  const theme = useTheme();
  const styles = useStyles();
  const session = useSession();
  const views = useMemo(allEntities, []);
  const [view, setView] = useState<EntityView>(() => {
    // An empty registry is a fork half-done. The throw lives in the lazy
    // initializer so hook order stays unconditional; it surfaces in the
    // console as a named error rather than a bare crash on views[0].
    if (views.length === 0) {
      throw new Error(
        `No entities are registered — add one to instances/${__APP_INSTANCE__}/src/index.ts.`
      );
    }
    return views[0];
  });
  /**
   * What each entity is filtered to, kept here so it survives the `key` remount
   * below — switch tabs and back and your filters and search are still applied,
   * which is what every grid people already use does. Per session only: a
   * reload starts clean, and the chips row is how a filtered tab says so.
   */
  const [filters, setFilters] = useState<Record<string, Filters>>({});

  /** True while a sign-in attempt runs — the silent one on load, or the button. */
  const [authBusy, setAuthBusy] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // The silent paths: embedded handoff, local fixture account, stored refresh
  // token. A failure is shown, not swallowed — on the local backend "signed
  // out" is unreachable by design, so silence would read as a broken app.
  useEffect(() => {
    resumeSession()
      .catch((e) => setAuthError(readable(e)))
      .finally(() => setAuthBusy(false));
  }, []);

  const onSignIn = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signIn();
    } catch (e) {
      setAuthError(readable(e));
    } finally {
      setAuthBusy(false);
    }
  };

  return (
    <FluentProvider theme={theme}>
      <ToastProvider>
        <div className={mergeClasses(styles.app, !isEmbedded && styles.ground)}>
          {!isEmbedded && (
            <div className={styles.appbar}>
              <header className={styles.head}>
                <span className={styles.logo} aria-hidden="true">
                  <DatabaseRegular />
                </span>
                <Title3 as="h1">{APP_TITLE}</Title3>
                <span className={styles.spacer} />
                {isLocalBackend && <Badge appearance="outline">Local</Badge>}
                {session.user?.email && (
                  <Menu positioning="below-end">
                    <MenuTrigger disableButtonEnhancement>
                      <Button appearance="subtle" size="small" icon={<PersonCircleRegular />}>
                        {session.user.email}
                      </Button>
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        {/*
                          Nothing else to update: the session subscription hears
                          the sign-out and the whole UI follows it back to the
                          sign-in screen.
                        */}
                        <MenuItem
                          icon={<SignOutRegular />}
                          onClick={() =>
                            void client.auth.signOut().catch((e) => setAuthError(readable(e)))
                          }
                        >
                          Sign out
                        </MenuItem>
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                )}
              </header>
            </div>
          )}
          <main className={styles.page}>
            {/*
              No header at all inside the portal. Everything the header holds is
              the app naming itself — a logo, a title, the signed-in account —
              and the host chrome above the frame already does all three. What
              was left after dropping the title was a decorative icon sitting
              alone above the grid, and a strip of vertical space a narrow pane
              cannot spare. Standalone it moves into the app bar above, because
              there this app IS the chrome. (`isLocalBackend` cannot be true
              embedded — the portal hands us a deployed backend.)
            */}
            {authError && (
              <MessageBar intent="error" className={styles.bar}>
                <MessageBarBody>{authError}</MessageBarBody>
              </MessageBar>
            )}

            {/*
              Standalone the content needs a surface to sit on, or the ground
              above has nothing to frame. Embedded it must NOT have one: the
              portal already draws a card around the frame, and a second one
              inside it reads as a panel within a panel.
            */}
            <div className={isEmbedded ? undefined : styles.surface}>
              {!session.isAuthenticated && authBusy ? (
                // The silent resume is still running — embedded handoff, local
                // fixture, or a stored refresh token. Showing the sign-in pitch
                // here means flashing "needs a click" at users who will never
                // need one; a plain spinner promises nothing.
                <section className={styles.empty} aria-busy="true">
                  <Spinner label="Signing in…" labelPosition="below" />
                </section>
              ) : !session.isAuthenticated ? (
                <section className={styles.empty}>
                  <LockClosedRegular className={styles.lockIcon} aria-hidden="true" />
                  <Subtitle2 block>Sign in to continue</Subtitle2>
                  <Caption1 block className={styles.muted}>
                    Opened from the Fabric portal this is automatic. On localhost the portal has to be
                    opened as a broker, which needs a click.
                  </Caption1>
                  <Button appearance="primary" onClick={() => void onSignIn()}>
                    Sign in with Fabric
                  </Button>
                </section>
              ) : (
                <>
                  <TabList
                    selectedValue={view.name}
                    onTabSelect={(_, d) => setView(views.find((v) => v.name === d.value) ?? views[0])}
                  >
                    {views.map((v) => (
                      <Tab key={v.name} value={v.name}>
                        {v.title}
                      </Tab>
                    ))}
                  </TabList>
                  {/*
                  The key resets per-MOUNT presentation: open dialogs and
                  measured column widths. Filters and search deliberately live
                  above it, so they survive a tab switch. Data races are TanStack
                  Query's problem, not the key's; see EntityPage.
                */}
                  <EntityPage
                    key={view.name}
                    view={view}
                    filters={filters[view.name] ?? NO_FILTERS}
                    onFilters={(next) => setFilters((prev) => ({ ...prev, [view.name]: next }))}
                  />
                </>
              )}
            </div>
          </main>
        </div>
      </ToastProvider>
    </FluentProvider>
  );
}

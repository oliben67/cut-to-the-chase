// Bundle entry point (esbuild, IIFE output -- see docs/development/
// renderer-refactor-implementation-plan.md for why this must stay a
// classic script, never `type="module"`: the e2e harness's whole
// substitution mechanism depends on app.js's top-level bindings, and
// this bundle's, being real `window` globals). Loaded before app.js in
// index.html. Each extracted domain module re-assigns whatever
// identifiers renderer-spec.js touches onto `window` as it's added here.
import { store } from "./shared/store";
import * as format from "./shared/format";
import * as ctxMenuModule from "./shared/ctx-menu";
import * as statusBar from "./modules/status-bar";
import * as gateway from "./modules/gateway";
import * as dockerHost from "./modules/docker-host";
import * as preferences from "./modules/preferences";
import * as events from "./modules/events";
import * as pollRate from "./shared/poll-rate";
import * as redisCli from "./modules/redis-cli";

(window as unknown as { __cttcModules: { ready: boolean } }).__cttcModules = {
  ready: true,
};
void store;

// FMT domain (app.js's former ~L240-380 color/formatting helpers) -- each
// re-assigned onto window since app.js still calls these by bare identifier
// as a classic script, and renderer-spec.js reassigns some of them the same
// way for tests (see the file banner above).
Object.assign(window, format);

// Shared context menu (app.js's former ~L786-868) -- ctxMenu/closeCtxMenu,
// now backed by @floating-ui/dom for positioning (see shared/ctx-menu for
// why: the existing e2e suite checks #ctxmenu exists synchronously right
// after the triggering event, so opening stays synchronous; only the
// position refinement afterward is async). No mount() needed: nothing
// here reads an app.js global at this module's own top level.
Object.assign(window, ctxMenuModule);

// SBAR domain (message/history/visibility slice of app.js's former
// ~L3818-3974 status bar block, plus flashStatus from ~L4480) -- same
// reasoning, including mountStatusBar itself: this bundle's script tag
// runs *before* app.js's, so mountStatusBar() can't run yet here -- it
// reads app.js globals (see shared/legacy-globals.ts),
// which don't exist until app.js has actually executed. Exposed on window
// and called back in from app.js's own boot sequence instead, at the same
// point the original inline code ran.
Object.assign(window, statusBar);

// GATE + DHOST domains (app.js's former gateway dialogs ~L4440-4750, docker
// host dialogs ~L2666-3085/3846-4284, and both status-bar pills
// ~L5935-6307) -- same reasoning: mountGateway()/mountDockerHost() are
// called back in from app.js's own boot sequence (see entry.ts callers),
// not run here, since they read app.js globals not yet defined at this
// bundle's own load time.
Object.assign(window, gateway);
Object.assign(window, dockerHost);

// PREF domain, narrowed to just the Settings/Preferences dialog's pane-
// switching shell (app.js's former ~L3552-3576) -- see
// modules/preferences/index.ts for why the individual fields stayed put.
// No mount() needed: unlike gateway/docker-host, nothing here calls an
// app.js global at this module's own top level.
Object.assign(window, preferences);

// EVT domain (app.js's former ~L3626-4152: event CRUD dialogs plus the
// UI-hosted event evaluation engine) -- mountEvents() (which starts the
// evaluation loop) is called back in from app.js's own boot sequence, same
// reasoning as gateway/docker-host's mount functions.
Object.assign(window, events);

// cRate (client-side refresh-rate throttle, clamped up to the server's own
// sRate) -- mountPollRate() is called back in from app.js's own boot
// sequence, same reasoning as gateway/docker-host/events' mount functions.
Object.assign(window, pollRate);

// Developer-only Redis CLI (Help > Developers > Redis CLI…) -- no mount()
// needed: nothing here reads an app.js global at this module's own top
// level, same reasoning as the PREF domain above.
Object.assign(window, redisCli);

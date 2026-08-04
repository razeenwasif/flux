/**
 * Launcher column — Flux's native pages above the user's terminal apps, in a
 * narrow column of their own immediately left of the calendar/mail column.
 *
 * Both used to be horizontal strips docked *above* the content card. Between
 * them that cost the page ~76px of height on every tab, permanently, for a
 * launcher you reach for a few times an hour — and height is the scarce axis on
 * a 16:9 display, not width. Vertical they spend width the window already had
 * and hand the card its full height back.
 *
 * A sibling column, not an overlay: the content card shrinks and the native tab
 * webview relayout follows it, the same contract the bookmark bar keeps.
 */
import { Suspense, lazy, type Component } from "solid-js";

import RailTip from "./RailTip";

const PagesBar = lazy(() => import("./PagesBar"));
const TuiAppsBar = lazy(() => import("./TuiAppsBar"));

const BarsColumn: Component = () => (
  <aside class="bars-col">
    {/* Pages take the slack: the list is fixed and long. Terminal apps sit
        below with a ceiling, so a user with twenty of them can't push the
        native pages off the top. */}
    <Suspense>
      <PagesBar />
    </Suspense>
    <Suspense>
      <TuiAppsBar />
    </Suspense>
    {/* One shared hover label for both bars — the chips are icon-only. */}
    <RailTip />
  </aside>
);

export default BarsColumn;

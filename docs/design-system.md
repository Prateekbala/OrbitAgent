# Orbit interface

The workspace uses a charcoal shell, a warm neutral sidebar, white content surfaces, and the #F8CB46 yellow accent. Status indicators use a restrained semantic palette. The public landing page keeps its landscape artwork and coral accents. Marketing styling is scoped to its CSS module.

## Components

Shared controls in `apps/web/components/ui` are based on shadcn/ui's New York registry and retain its MIT notice. Radix provides dialog focus management, tooltips, tabs, and keyboard navigation. Tailwind CSS 4 supplies component utilities; `cn` combines conditional classes and resolves utility conflicts. Add components using the aliases in `apps/web/components.json`.

Use `Button`, `Input`, `Textarea`, `NativeSelect`, `Badge`, and `Card` instead of new native control styling. Native selects preserve browser keyboard and form behavior. Their wrapper supplies the chevron; parent layouts should target `data-slot="native-select-wrapper"` when necessary. Checkbox and radio inputs retain their native semantics and compact dimensions.

Use the shared application `Dialog` for controlled dialogs. It restores focus to the opener, traps keyboard focus, supports Escape, and scrolls on short viewports. Keep a visible title and label every control. Use `Card asChild` when an existing article, section, form, or details element needs the card appearance. Put list keys on the outermost component.

## Styling

Semantic colors, radii, and compatibility tokens live in `apps/web/app/globals.css`. Shared refinements and the workspace layout live in `apps/web/app/workspace-theme.css`. Keep base element defaults in `@layer base`; unlayered element resets override Tailwind utilities.

Use #F8CB46 for workspace navigation and primary actions, with dark text. Use dark gold or neutral ink for links and active text on white; yellow text on white lacks sufficient contrast. Use green for presence/success, blue for information, amber for waiting, and red for errors. Retain written status labels: color is supplementary. Avatars and task labels use a small, consistent palette. Avoid gradients, large marketing headlines, decorative statistics, and unrelated colors inside the workspace. User-provided images and files keep their original appearance.

The desktop layout has a global search bar, shortcut rail, a searchable conversation sidebar, and a full-width message pane. Workspace tools appear below channels and direct messages. Member controls stay in the channel header; channel details open on demand. Calendar-day separators participate in the measured, virtualized timeline. Mobile navigation opens as a drawer and restores focus on dismissal.

## Appearance

The appearance control is available in the shortcut rail, mobile header, sign-in screen, and account settings. Light remains the default; Dark and System are explicit choices. `next-themes` applies the saved preference before hydration and synchronizes it across tabs. The preference is device-local under `orbit-appearance`; it contains no account or workspace data.

`apps/web/app/appearance.css` defines dark semantic tokens and themed status colors. `apps/web/app/workspace-polish.css` defines the chat layout and responsive refinements. Use the shared surface, foreground, input, border, and status tokens instead of fixed light colors. Preserve #F8CB46 and its dark foreground in both modes. Keep user images, emoji, and attachments in their original colors. The public landing page retains its colorful marketing treatment.

Isolated tool forms receive only a validated light/dark value over their existing nonce-fenced messaging channel. Appearance changes update native color-scheme without reloading the iframe or discarding typed values. The opaque origin, restrictive CSP, and submission verification remain in place. Honor reduced-motion preferences.

## Verification

Run `npm run typecheck` and `npm run build -w @ao/web`, then `CI=1 npm run test:e2e`. If the development app is already on port 3000, use `CI=1 PLAYWRIGHT_PORT=3100 npm run test:e2e`. Browser fixtures use isolated databases. The UI coverage visits every workspace destination in both themes, checks persistence, system preference changes and cross-tab updates, exercises dialog keyboard behavior and small viewports, and captures desktop/mobile previews.

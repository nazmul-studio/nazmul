<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Portfolio architecture
- Keep the supplied portfolio, content provider, studio routes, and Kyoto renderer in the existing TanStack Start structure; preservation avoids regressions in its book and scene interactions.
- Reserve typed text with a full-text measurement layer and expose a single static accessible text value; animation must never change document geometry or repeat announcements.
- Use Radix disclosure and dialog primitives for navigation and project details; native focus and Escape handling prevent custom accessibility regressions.

# Book Weaver

Set up and implement the project from the attached nazmul-portfolio-cloudflare.zip codebase and execute the approved 14-phase visual Book Editor roadmap specified in Lovable_Visual_Book_Editor_14_Prompts.pdf, starting with Phase 1.

Key requirements and clarifications:
1. One Canonical Renderer: Public Book = Admin Book Editor = Preview = Published Book using the identical data model and BookRenderer.
2. Canonical Element Model: Support text, image, and shape (rectangle, rounded rectangle, circle/ellipse, and line with stroke/color/width). Elements support x, y, width, height, rotation, scale, opacity, zIndex, visibility, and styles.
3. Backward-Compatible Migration: Seamlessly migrate the existing 15-page achievements data into the new page/element model preserving all text, titles, years, tags, front/back leaves, and visual appearance without data loss.
4. Unlimited Pages: Remove any artificial 15-page ceiling; support adding, duplicating, deleting, and reordering arbitrary pages.
5. Canvas Contact Page: An editable contact page as a normal page inside the book with editable canvas elements for Email, GitHub, LinkedIn, Facebook, and custom links.
6. Operation-based Undo/Redo & Autosave: Clean operation-based history stack and debounced autosave hooked into the existing draft and conflict detection system. Restore from Version History loads to Draft first without auto-publishing.
7. Image Storage Abstraction: Do not store raw binary images in Book JSON or KV; prepare a clean abstraction ready for Cloudflare R2.
8. Preservation: Keep existing password authentication, signed session cookies, CSRF/security headers, and Cloudflare Worker/KV architecture completely intact. Implement phase-by-phase with full verification.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/13dbfee2-241d-4d94-b1a5-1a29b021fb10).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

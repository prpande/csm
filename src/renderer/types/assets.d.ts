// Let the renderer import image assets (the title-bar brand icon, #86). Vite
// resolves a `*.png` import to a bundled URL string served from the app origin
// (satisfies the CSP `img-src 'self'`); this declaration gives TypeScript the
// matching module shape.
declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.module.scss" {
  const classes: Record<string, string>;
  export default classes;
}

interface ImportMeta {
  readonly env: { readonly PROD: boolean };
}

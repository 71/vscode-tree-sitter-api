declare const DEV: boolean;

declare module "*.wasm" {
  const path: string;
  export default path;
}

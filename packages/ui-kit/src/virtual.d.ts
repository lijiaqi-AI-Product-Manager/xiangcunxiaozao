declare module 'virtual:brand' {
  import type { Brand } from '@pkg/contract';
  const config: { brand: Brand; tokens: Record<string, string> };
  export default config;
}

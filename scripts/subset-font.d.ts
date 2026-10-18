// subset-font 没有自带类型声明，这里按它的实际用法补一个最小声明
declare module 'subset-font' {
  export default function subsetFont(
    font: Buffer | Uint8Array,
    text: string,
    options?: { targetFormat?: 'sfnt' | 'woff' | 'woff2' | 'truetype'; preserveNameIds?: number[]; variationAxes?: Record<string, number | { min: number; max: number }> },
  ): Promise<Buffer>;
}

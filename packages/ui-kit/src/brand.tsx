import type { CSSProperties, ReactNode } from 'react';

/** 当前外观：成品态（默认，验收只认这一版）/ 骨架态（?skin=skeleton，只做功能验证） */
export type Skin = 'finished' | 'skeleton';
export const currentSkin = (): Skin => (document.documentElement.dataset.skin === 'skeleton' ? 'skeleton' : 'finished');

/**
 * 圆戳印章（54号 问题一：全站唯一组件）：红文圆戳，外圈 1px 细环（印泥红 75%）+ 书法印文，整体不透明度 .85。
 * 只有三个尺寸：lg 44（大画态店标）/ md 36（详情页落款）/ sm 28（主页面、横幅卡、点按小印）。字来自品牌配置，代码里不写死。
 * 样式在顾客端的 .seal 里；老板端不用印章。
 */
export function Seal({ char, size = 'sm', pressable = false, style }: { char: string; size?: 'lg' | 'md' | 'sm'; pressable?: boolean; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`seal ${size}${pressable ? ' pressable' : ''}`} style={style}>{char}</span>;
}

/**
 * 大幅半透明书法字水印（26号 §三），不挡点击、读屏软件忽略。
 * 30号 高斯：手机上要能看全——整列字占屏幕可见高度的 88%（svh：工具栏弹出来也不会切掉首尾的字）。
 * 53号 高斯：压在面板前面（层级、透明度在样式里），手机上不再被面板盖死。
 */
export function Watermark({ text }: { text: string }) {
  const chars = Math.max(1, [...text].length);
  return (
    <div aria-hidden="true" className="watermark">
      <span style={{ fontSize: `calc(88svh / ${chars})` }}>{text}</span>
    </div>
  );
}

/**
 * 线稿空状态（26号 §三）：一只冒热气的碗，线条稍带手绘的不规整。
 */
export function LineArtBowl({ size = 120 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" fill="none"
      stroke="var(--color-lineart)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M44 34c-4-6 4-9 0-16" />
      <path d="M60 30c-4-7 5-10 0-18" />
      <path d="M76 34c-4-6 4-9 0-16" />
      <path d="M18 54.5c1 0 83-1.2 84 .3-1.5 22.5-19 37.7-42.3 37.4C37 91.9 19.3 76.6 18 54.5z" />
      <path d="M45 92.5c-.8 5 1 7.8 3 8.5 8 .9 17 .8 24.5-.2 2.2-.8 3.6-3.6 2.8-8.3" />
      <path d="M30 63c4.5 9 13 15.5 25 17" opacity="0.6" />
    </svg>
  );
}

export function EmptyArt({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="empty-art">
      <LineArtBowl />
      <h2>{title}</h2>
      {children}
    </section>
  );
}

import { useState, type CSSProperties } from 'react';
import { Seal } from './brand.tsx';

interface Props {
  src: string | null;
  name: string;
  /** 宽高比，固定容器防止图片加载时布局跳动（23号 §四 #5） */
  ratio?: string;
  caption?: string;
  /** 骨架态占位里是否写菜名：列表页旁边已有标题，传 false 避免重复（25号 §1.5） */
  showName?: boolean;
  /** 成品态占位：传入印章字后显示「浅色底 + 书法菜名 + 印章小样」（26号 §四）；不传 = 骨架态灰块 */
  seal?: string | null;
  style?: CSSProperties;
}

/**
 * 菜品图：有图显示图；没图或加载失败一律显示占位，绝不空白塌陷、绝不回退到任何旧图（21号 §5.3）。
 */
export function DishImage({ src, name, ratio = '1 / 1', caption = '实拍图上线中', showName = true, seal = null, style }: Props) {
  const [failed, setFailed] = useState(false);
  const box: CSSProperties = {
    aspectRatio: ratio,
    width: '100%',
    borderRadius: 'var(--radius-card)',
    overflow: 'hidden',
    background: 'var(--color-placeholder-bg)',
    position: 'relative',
    ...style,
  };
  if (src && !failed) {
    return (
      <div style={box}>
        <img src={src} alt={name} loading="lazy" onError={() => setFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </div>
    );
  }
  if (seal) {
    return (
      <div style={{ ...box, containerType: 'inline-size', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, padding: 8, textAlign: 'center' }} role="img" aria-label={`${name}，${caption}`}>
        <span style={{ fontFamily: 'var(--font-family-brush)', fontSize: 'clamp(14px, 19cqw, 30px)', lineHeight: 1.15, color: 'var(--color-text)', textWrap: 'balance' } as CSSProperties}>{name}</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', letterSpacing: 1 }}>{caption}</span>
        <Seal char={seal} size="sm" style={{ position: 'absolute', right: 6, bottom: 6 }} />
      </div>
    );
  }
  return (
    <div style={{ ...box, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: 8, textAlign: 'center' }} role="img" aria-label={`${name}，${caption}`}>
      {showName && <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-text)', fontWeight: 600, lineHeight: 1.3 }}>{name}</span>}
      <span style={{ fontSize: 'var(--font-size-caption)', color: 'var(--color-text-secondary)' }}>{caption}</span>
    </div>
  );
}

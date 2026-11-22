import type { IconProps } from './dsh-ui.ts';
import artwork from '../../icon.svg';

// 宿主入口取前景色，未指定尺寸时填满菜单或按钮的图标槽。
export function StashIcon({ size, className }: IconProps) {
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        display: 'inline-block',
        width: size ?? '100%',
        height: size ?? '100%',
        backgroundColor: 'currentColor',
        forcedColorAdjust: 'preserve-parent-color',
        mask: `url(${JSON.stringify(artwork)}) center / contain no-repeat`,
      }}
    />
  );
}

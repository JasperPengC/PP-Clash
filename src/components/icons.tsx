import type { ReactNode, SVGProps } from 'react';
import { ProductIcon } from './ProductIcon';

/**
 * 产品导航与小面板共用 ProductIcon（Phosphor Regular）。
 * 其他细分操作保留统一 24×24 画布、1.6 描边的辅助图标。
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconOverview = (p: IconProps) => <ProductIcon {...p} name="overview" />;

export const IconNodes = (p: IconProps) => <ProductIcon {...p} name="nodes" />;

export const IconLocate = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="6.5" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />
  </Svg>
);

export const IconSecurity = (p: IconProps) => <ProductIcon {...p} name="security" />;

export const IconProfiles = (p: IconProps) => <ProductIcon {...p} name="profiles" />;

export const IconSettings = (p: IconProps) => <ProductIcon {...p} name="settings" />;

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.6" />
    <path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2.5 12h2m15 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const IconPower = (p: IconProps) => <ProductIcon {...p} name="quit" />;

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => <ProductIcon {...p} name="refresh" />;

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="m14.5 5.5 4 4M4 20l4.2-.8L19 7.4 15 3.5 4.8 13.7 4 20Z" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V5.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V7" />
    <path d="M6.6 7l.8 12.1c0 .5.4.9.9.9h7.4c.5 0 .9-.4.9-.9L17.4 7" />
  </Svg>
);

export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v10.2m0 0 4-4m-4 4-4-4" />
    <path d="M5 18.5h14" />
  </Svg>
);

export const IconCheck = (p: IconProps) => <ProductIcon {...p} name="check" />;

export const IconChevronDown = (p: IconProps) => <ProductIcon {...p} name="expand" />;

export const IconChevronRight = (p: IconProps) => <ProductIcon {...p} name="next" />;

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.2 21 19.5H3L12 4.2Z" />
    <path d="M12 9.5v4.2M12 16.8v.01" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11v5.2M12 7.9v.01" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => <ProductIcon {...p} name="dns" />;

export const IconTun = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.2" y="5" width="17.6" height="11.6" rx="2.2" />
    <path d="M8.5 20.5h7M12 16.6v3.9" />
  </Svg>
);

export const IconBuild = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.7 6.3a3.9 3.9 0 0 0 5 5l-8.5 8.5a2.6 2.6 0 0 1-3.7-3.7l8.5-8.5Z" />
    <path d="M6.5 6.5 4 4" />
  </Svg>
);

export const IconFolder = (p: IconProps) => <ProductIcon {...p} name="resources" />;

export const IconUpload = (p: IconProps) => <ProductIcon {...p} name="upload" />;

export const IconDownload = (p: IconProps) => <ProductIcon {...p} name="download" />;

export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2.8 5.2 13h5.6l-.8 8.2L18.8 11h-5.6l.8-8.2Z" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.4" />
    <path d="m16 16 4 4" />
  </Svg>
);

export const IconSort = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h9M4 12h6M4 17h4" />
    <path d="M18 8v9m0 0 2.6-2.6M18 17l-2.6-2.6" />
  </Svg>
);

export const IconPause = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5.5v13M15 5.5v13" strokeWidth={2} />
  </Svg>
);

export const IconActivity = (p: IconProps) => <ProductIcon {...p} name="traffic" />;

export const IconRules = (p: IconProps) => <ProductIcon {...p} name="rules" />;

export const IconLog = (p: IconProps) => <ProductIcon {...p} name="logs" />;

export const IconLink = (p: IconProps) => <ProductIcon {...p} name="connections" />;

export const IconSliders = (p: IconProps) => <ProductIcon {...p} name="overrides" />;

export const IconChip = (p: IconProps) => <ProductIcon {...p} name="kernel" />;

export const IconPalette = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.7-.7 1.7-1.7 0-1-.7-1.6-.7-2.4 0-1 .8-1.7 1.8-1.7h1.7c1.7 0 3-1.3 3-3A8.5 8.5 0 0 0 12 3.5Z" />
    <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none" />
    <circle cx="15.8" cy="10" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8 6.5-5 5.5 5 5.5M16 6.5l5 5.5-5 5.5M13.5 3.5l-3 17" />
  </Svg>
);

export const IconRestart = (p: IconProps) => <ProductIcon {...p} name="restart" />;

export const IconPin = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p}>
    <path
      d="M9.2 3h5.6l-.9 5 3.4 3.4-5.6 1.5L8.4 20l-1.3-.7 2.8-7.1-3.4-3.4L8.6 3h.6Z"
      fill={filled ? 'currentColor' : 'none'}
    />
  </Svg>
);

export const IconFlag = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p}>
    <path
      d="M5.5 21V3.8c2.8-1.7 5.4 1.8 8.2.2 1.4-.8 2.6-1 3.8-.7v8.2c-1.2-.3-2.4-.1-3.8.7-2.8 1.6-5.4-1.9-8.2-.2"
      fill={filled ? 'currentColor' : 'none'}
    />
  </Svg>
);

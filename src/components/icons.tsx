import type { ReactNode, SVGProps } from 'react';

/**
 * 线性图标集。统一 24×24 viewBox、1.6 描边，尺寸由 size 控制。
 * 全部手写，不引图标库：图标数量可控，避免多打包一个依赖。
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

export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 18a8 8 0 1 1 16 0" />
    <path d="m12 14 3.6-3.6" />
    <circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconNodes = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="2.2" />
    <circle cx="5" cy="18" r="2.2" />
    <circle cx="19" cy="18" r="2.2" />
    <path d="M12 7.2 6.5 15.9M12 7.2l5.5 8.7M7.2 18h9.6" />
  </Svg>
);

export const IconSecurity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.2 4.8 6v6c0 4.2 3 7.2 7.2 8.8 4.2-1.6 7.2-4.6 7.2-8.8V6L12 3.2Z" />
    <path d="m9.2 12 2 2 3.6-3.8" />
  </Svg>
);

export const IconProfiles = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 16.5a4 4 0 0 1-.4-8A5.2 5.2 0 0 1 17 9.2a3.6 3.6 0 0 1 .6 7.3" />
    <path d="M12 11.5v7.2m0 0 2.6-2.6M12 18.7l-2.6-2.6" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.1 14.6a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c0 .68.4 1.3 1.03 1.56a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.55 1.03Z" />
  </Svg>
);

export const IconPower = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v8.5" />
    <path d="M6.4 6.4a8 8 0 1 0 11.2 0" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11.5a8 8 0 1 0-2.1 5.6" />
    <path d="M20 5.5v6h-6" />
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

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.4 4.4L19 7.2" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5.5 9 6.5 6.5L18.5 9" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9.5 5.5 7 6.5-7 6.5" />
  </Svg>
);

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

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M3.5 12h17M12 3.4c2.6 3 2.6 14.2 0 17.2M12 3.4c-2.6 3-2.6 14.2 0 17.2" />
  </Svg>
);

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

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7.5c0-.8.6-1.5 1.5-1.5h4l1.6 2h8.4c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5H5c-.9 0-1.5-.7-1.5-1.5v-10Z" />
  </Svg>
);

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V5m0 0 4.5 4.5M12 5 7.5 9.5" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v14m0 0 4.5-4.5M12 18l-4.5-4.5" />
  </Svg>
);

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

export const IconActivity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12h4l2.5-6 4 12 2.5-6h4" />
  </Svg>
);

export const IconRules = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 6.5h14M5 12h14M5 17.5h9" />
    <circle cx="18.5" cy="17.5" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconLog = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 3.8h8.2L18.5 8.6v11.6h-13V3.8Z" />
    <path d="M13.5 4v5h5M8.5 12.5h7M8.5 16h4.5" />
  </Svg>
);

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M7.8 10.2 6.2 11.8a3.2 3.2 0 0 0 4.5 4.5l1.6-1.6" />
    <path d="M16.2 13.8l1.6-1.6a3.2 3.2 0 0 0-4.5-4.5l-1.6 1.6" />
  </Svg>
);

export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h7M15 7h5M4 12h3M11 12h9M4 17h9M17 17h3" />
    <circle cx="13" cy="7" r="1.8" />
    <circle cx="9" cy="12" r="1.8" />
    <circle cx="15" cy="17" r="1.8" />
  </Svg>
);

export const IconChip = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4" />
  </Svg>
);

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
    <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.3 5.5l-2.6 13" />
  </Svg>
);

export const IconRestart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.5v5" />
    <path d="M6.7 7.2a8 8 0 1 0 10.6 0" />
  </Svg>
);

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

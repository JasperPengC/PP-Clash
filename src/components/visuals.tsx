import { useId } from 'react';
import { IconPower } from './icons';
import { Spinner } from './ui';

/** 呼吸光点：连接 / 内核状态用。CSS 动画驱动，不占主线程。 */
export function BreathingDot({ color, active = true }: { color: string; active?: boolean }) {
  return (
    <span
      className={`dot${active ? ' dot-breathing' : ''}`}
      style={{ background: active ? color : 'var(--text-muted)', color: active ? color : undefined }}
    />
  );
}

/** 延迟环：一圈进度弧 + 中心读数。 */
export function LatencyRing({ ms, reading, busy = false, size = 72 }: {
  ms: number | null; reading?: string; busy?: boolean; size?: number;
}) {
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const progress = ms != null && ms > 0 ? Math.max(.08, 1 - ms / 500) : 0;
  const text = reading ?? (ms != null && ms > 0 ? `${ms} ms` : '未测');
  const numeric = text.match(/^(\d+(?:\.\d+)?) ms$/);
  return <span className="latency-ring" style={{ width: size, height: size }}>
    <svg viewBox="0 0 72 72" aria-hidden="true">
      <circle className="latency-ring-track" cx="36" cy="36" r={radius} />
      {progress > 0 && <circle className="latency-ring-value" cx="36" cy="36" r={radius}
        strokeDasharray={`${circumference * progress} ${circumference}`} />}
    </svg>
    <span className="latency-ring-reading">{busy ? <Spinner small /> : numeric
      ? <><strong className={numeric[1].length > 3 ? 'is-long' : undefined}>{numeric[1]}</strong>{' '}<small>ms</small></>
      : <span className="latency-ring-status">{text}</span>}</span>
  </span>;
}

const CHART_W = 600;
const CHART_H = 110;

function linePath(points: number[], max: number, linear = false): string {
  if (points.length < 2) return '';
  const dx = CHART_W / (points.length - 1);
  const y = (v: number) => CHART_H - 3 - (v / max) * (CHART_H - 13);
  const pts = points.map((v, i) => [dx * i, y(v)] as const);
  let d = `M ${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (linear) { d += ` L ${x1.toFixed(2)},${y1.toFixed(2)}`; continue; }
    const cx = (x0 + x1) / 2;
    d += ` C ${cx.toFixed(2)},${y0.toFixed(2)} ${cx.toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  return d;
}

/** 上下行流量曲线：双线 + 渐变填充，空数据时给出明确的空态。 */
export function TrafficChart({
  up,
  down,
  upColor = 'var(--accent)',
  downColor = 'var(--chart-down, #a066ff)',
}: {
  up: number[];
  down: number[];
  upColor?: string;
  downColor?: string;
}) {
  const uid = useId().replace(/[:]/g, '');
  const hasData = [...up, ...down].some((v) => v > 0.5);
  const max = Math.max(1, ...up, ...down);

  const upLine = linePath(up, max, true);
  const downLine = linePath(down, max, true);
  const area = (line: string) => `${line} L ${CHART_W},${CHART_H} L 0,${CHART_H} Z`;

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`up-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={upColor} stopOpacity="0.26" />
            <stop offset="100%" stopColor={upColor} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`down-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={downColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={downColor} stopOpacity="0" />
          </linearGradient>
        </defs>

        <g className="chart-grid">
          <line x1="0" y1="1" x2={CHART_W} y2="1" />
          <line x1="0" y1={CHART_H / 2} x2={CHART_W} y2={CHART_H / 2} />
          <line x1="0" y1={CHART_H - 1} x2={CHART_W} y2={CHART_H - 1} />
        </g>

        {hasData && downLine && (
          <>
            <path d={area(downLine)} fill={`url(#down-${uid})`} />
            <path
              d={downLine}
              fill="none"
              stroke={downColor}
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </>
        )}
        {hasData && upLine && (
          <>
            <path d={area(upLine)} fill={`url(#up-${uid})`} />
            <path
              d={upLine}
              fill="none"
              stroke={upColor}
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </>
        )}
      </svg>

      {!hasData && <div className="chart-empty">暂无流量数据</div>}
    </div>
  );
}

/** 主连接按钮：大圆形电源键，连接态用品牌渐变。 */
export function PowerButton({
  on,
  busy,
  disabled,
  label,
  size = 54,
  onClick,
}: {
  on: boolean;
  busy?: boolean;
  disabled?: boolean;
  label: string;
  size?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`power${on ? ' on' : ''}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      aria-pressed={on}
      title={label}
    >
      <span className="power-hint" />
      {busy ? <Spinner /> : <IconPower size={Math.round(size * 0.4)} />}
    </button>
  );
}


/** 迷你趋势线：统计卡底部用，面积填充 + 平滑曲线。 */
export function MiniSparkline({
  points,
  color,
  height = 44,
}: {
  points: number[];
  color: string;
  height?: number;
}) {
  const uid = useId().replace(/[:]/g, '');
  const W = 240;
  const has = points.some((v) => v > 0.5);
  const max = Math.max(1, ...points);
  const dx = W / Math.max(points.length - 1, 1);
  const y = (v: number) => height - 5 - (v / max) * (height - 12);
  const pts = points.map((v, i) => [dx * i, y(v)] as const);

  let line = `M ${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const cx = (x0 + x1) / 2;
    line += ` C ${cx.toFixed(2)},${y0.toFixed(2)} ${cx.toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  const area = `${line} L ${W},${height} L 0,${height} Z`;

  return (
    <div className="mini-chart" style={{ height }}>
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`mini-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {has ? (
          <>
            <path d={area} fill={`url(#mini-${uid})`} />
            <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
          </>
        ) : (
          <line
            x1="0"
            y1={height - 3}
            x2={W}
            y2={height - 3}
            stroke="var(--border)"
            strokeWidth={1}
            strokeDasharray="3 5"
          />
        )}
      </svg>
    </div>
  );
}

/** 单方向速率曲线：代理为实线带面积，直连为虚线，两者共用纵轴。 */
export function SplitSparkline({ proxy, direct, color }: { proxy: number[]; direct: number[]; color: string }) {
  const uid = useId().replace(/[:]/g, '');
  const W = 240;
  const H = 40;
  const max = Math.max(1, ...proxy, ...direct);
  const has = proxy.some(v => v > 0.5) || direct.some(v => v > 0.5);
  const path = (points: number[]) => {
    const dx = W / Math.max(points.length - 1, 1);
    const pts = points.map((v, i) => [dx * i, H - 2 - (v / max) * (H - 8)] as const);
    let d = `M ${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const cx = (x0 + x1) / 2;
      d += ` C ${cx.toFixed(2)},${y0.toFixed(2)} ${cx.toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
    }
    return d;
  };
  const proxyLine = path(proxy);
  return (
    <svg className="split-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`split-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {has ? <>
        <path d={`${proxyLine} L ${W},${H} L 0,${H} Z`} fill={`url(#split-${uid})`} />
        <path d={proxyLine} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <path d={path(direct)} fill="none" stroke={color} strokeWidth={1.2} strokeOpacity={0.55} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      </> : <line x1="0" y1={H - 2} x2={W} y2={H - 2} stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="2 5" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** 按「代理 / 直连」拆分的上传、下载四条实时曲线。 */
export function RouteTrafficChart({
  proxyUp,
  proxyDown,
  directUp,
  directDown,
  upColor = 'var(--up)',
  downColor = 'var(--down)',
}: {
  proxyUp: number[];
  proxyDown: number[];
  directUp: number[];
  directDown: number[];
  upColor?: string;
  downColor?: string;
}) {
  const uid = useId().replace(/[:]/g, '');
  const all = [...proxyUp, ...proxyDown, ...directUp, ...directDown];
  const hasData = all.some((v) => v > 0.5);
  const max = Math.max(1, ...all);

  const series = [
    { points: proxyUp, color: upColor, dash: undefined, opacity: 1 },
    { points: proxyDown, color: downColor, dash: undefined, opacity: 1 },
    { points: directUp, color: upColor, dash: '3 3', opacity: 0.5 },
    { points: directDown, color: downColor, dash: '3 3', opacity: 0.5 },
  ];

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`rp-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={upColor} stopOpacity="0.18" />
            <stop offset="100%" stopColor={upColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="chart-grid">
          <line x1="0" y1="1" x2={CHART_W} y2="1" />
          <line x1="0" y1={CHART_H / 2} x2={CHART_W} y2={CHART_H / 2} />
          <line x1="0" y1={CHART_H - 1} x2={CHART_W} y2={CHART_H - 1} />
        </g>
        {hasData &&
          series.map((item, i) => {
            const line = linePath(item.points, max);
            if (!line) return null;
            return (
              <path
                key={i}
                d={line}
                fill="none"
                stroke={item.color}
                strokeWidth={1.6}
                strokeDasharray={item.dash}
                strokeOpacity={item.opacity}
                strokeLinecap="round"
              />
            );
          })}
      </svg>
      {!hasData && <div className="chart-empty">暂无流量数据</div>}
    </div>
  );
}

// 与 flag-icons 本地资源对应；未知国家码使用可读文字兜底。
const FLAG_CODES = new Set('ad ae af ag ai al am ao aq ar arab as asean at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cefta cf cg ch ci ck cl cm cn co cp cr cu cv cw cx cy cz de dg dj dk dm do dz eac ec ee eg eh er es es-ct es-ga es-pv et eu fi fj fk fm fo fr ga gb gb-eng gb-nir gb-sct gb-wls gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu ic id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pc pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh sh-ac sh-hl sh-ta si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um un us uy uz va vc ve vg vi vn vu wf ws xk xx ye yt za zm zw'.split(' '));

export function splitFlag(name: string): { code: string | null; rest: string } {
  const m = name.match(/^([\u{1F1E6}-\u{1F1FF}]{2})\s*/u);
  if (!m) return { code: null, rest: name };
  const code = [...m[1]]
    .map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0x1f1e6 + 65))
    .join('');
  return { code, rest: name.slice(m[0].length) };
}

export function NodeName({ name, className }: { name: string; className?: string }) {
  const { code, rest } = splitFlag(name);
  if (!code) return <span className={className}>{name}</span>;
  return (
    <span className={`node-name-with-code${className ? ` ${className}` : ''}`}>
      {FLAG_CODES.has(code.toLowerCase()) ? <span className={`fi fi-${code.toLowerCase()} node-flag-icon`} role="img" aria-label={code} /> : <span className="node-country-code">{code}</span>}
      <span className="node-name-text">{rest}</span>
    </span>
  );
}

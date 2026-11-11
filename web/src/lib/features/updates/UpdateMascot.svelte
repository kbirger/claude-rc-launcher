<script lang="ts">
  import { onMount } from "svelte";

  // The pixel crab from animation.html. It floats while nothing happens, bounces once when an update starts, then
  // twirls around its vertical axis until the update ends, and settles facing front again. When `celebrate` turns on
  // (an update just finished well) it throws its claws up, hops and sprays confetti.
  let { active = false, celebrate = false }: { active?: boolean; celebrate?: boolean } = $props();

  type Phase = "float" | "bounce" | "spin" | "settle" | "celebrate";
  const BOUNCE_S = 1.65;
  const CELEBRATE_S = 2.6;
  const CONFETTI_AT_S = 0.35; // when the claws are up
  const CONFETTI_COUNT = 34;
  const CONFETTI_COLORS = ["--primary", "--ok", "--warn", "--destructive"];
  const TAU = Math.PI * 2;
  const POWER = 0.65; // how far it moves
  const DRAG = 0.75; // how much the claws and legs lag behind a twirl

  const rows = [
    "....########....",
    "....########....",
    "....########....",
    "..############..",
    "..############..",
    "..############..",
    "....########....",
    "....########....",
    "....########....",
    "....#.#..#.#....",
    "....#.#..#.#....",
    "....#.#..#.#....",
  ];
  const cells: { x: number; y: number; eye: boolean; claw: boolean; leg: boolean; seed: number }[] = [];
  rows.forEach((r, y) =>
    [...r].forEach((v, x) => {
      if (v === "#") cells.push({ x, y, eye: y === 1 && (x === 5 || x === 10), claw: y >= 3 && y <= 5 && (x < 4 || x > 11), leg: y >= 9, seed: x * 127.1 + y * 311.7 });
    }),
  );

  let canvas: HTMLCanvasElement;
  let phase: Phase = "float";
  let time = 0; // runs all the time: it drives the float and the wobble
  let phaseTime = 0; // since the phase began
  let angle = 0;
  let velocity = 0;
  let settleTarget = 0;
  let wasActive = false;
  let wasCelebrate = false;
  let celebratePending = false; // the crab is busy (bouncing or slowing down): celebrate when it is back to float
  let confettiSpawned = false;
  type Piece = { x: number; y: number; vx: number; vy: number; rot: number; spin: number; size: number; life: number; age: number; color: string };
  let confetti: Piece[] = [];

  function startCelebrate() {
    phase = "celebrate";
    phaseTime = 0;
    confettiSpawned = false;
    celebratePending = false;
  }

  // The bounce starts when `active` turns on; the settle starts when it turns off.
  $effect(() => {
    const now = active;
    if (now && !wasActive) {
      celebratePending = false;
      if (phase === "settle") {
        phase = "spin"; // the update came back while the crab was slowing down: keep turning
      } else {
        phase = "bounce";
        phaseTime = 0;
        angle = 0;
        velocity = 0;
      }
    } else if (!now && wasActive && phase === "spin") {
      phase = "settle";
      phaseTime = 0;
      settleTarget = Math.ceil(angle / TAU) * TAU;
    }
    // A bounce that is still going when the update ends finishes first (see frame).
    wasActive = now;
  });

  // The celebration starts when `celebrate` turns on. A crab that is still turning slows down first.
  $effect(() => {
    const now = celebrate;
    if (now && !wasCelebrate && !active) {
      if (phase === "float") startCelebrate();
      else if (phase === "celebrate") phaseTime = 0;
      else celebratePending = true;
    }
    wasCelebrate = now;
  });

  function spawnConfetti(cell: number, x: number, y: number) {
    const style = getComputedStyle(canvas);
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const angle = -Math.PI * (0.12 + Math.random() * 0.76); // up and to both sides
      const speed = (10 + Math.random() * 12) * cell;
      confetti.push({
        x: x + (Math.random() - 0.5) * 6 * cell,
        y: y + Math.random() * cell,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        rot: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 14,
        size: cell * (0.4 + Math.random() * 0.45),
        life: 1.6 + Math.random() * 0.8,
        age: 0,
        color: style.getPropertyValue(CONFETTI_COLORS[i % CONFETTI_COLORS.length]!).trim() || "#e97050",
      });
    }
  }

  function frame(ctx: CanvasRenderingContext2D, dt: number, still: boolean) {
    time += dt;
    phaseTime += dt;
    const p = POWER;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(cw * dpr);
    const h = Math.round(ch * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const style = getComputedStyle(canvas);
    const body = style.getPropertyValue("--primary").trim() || "#e97050";
    const eye = style.getPropertyValue("--background").trim() || "#080808";

    // The canvas has room around the crab (1.5 times its size) for the confetti.
    const cell = Math.min(cw / 30, ch / 22.5);
    let jump = 0;
    let sx = 1;
    let sy = 1;
    let ax = 0;
    let raise = 0; // how far the claws are up, 0 to 1
    let spinning = false;
    const smooth = (v: number) => {
      const t = Math.min(1, Math.max(0, v));
      return t * t * (3 - 2 * t);
    };

    if (phase === "bounce") {
      const t = phaseTime / BOUNCE_S;
      if (t >= 1) {
        phase = active ? "spin" : "float";
        phaseTime = 0;
        if (phase === "float" && celebratePending) startCelebrate();
      } else {
        const curve = Math.sin(Math.PI * t);
        jump = curve * 2.3 * p;
        const impact = Math.exp(-Math.pow((t - 0.97) / 0.055, 2));
        sx = 1 + impact * 0.11 * p;
        sy = 1 - impact * 0.13 * p + curve * 0.08 * p;
        ax = Math.sin(time * 4) * 0.07 * p;
      }
    }
    if (phase === "spin") {
      // Speeds up slowly: the speed only levels off after several seconds.
      velocity += (1.6 * p - velocity * 0.12) * dt;
      angle += velocity * dt;
      spinning = true;
    } else if (phase === "settle") {
      // Slow down and stop facing front: the speed follows the angle that is left, so the stop is smooth.
      const left = settleTarget - angle;
      if (left < 0.02) {
        phase = "float";
        phaseTime = 0;
        angle = 0;
        velocity = 0;
        if (celebratePending) startCelebrate();
      } else {
        velocity = Math.min(velocity, Math.max(left * 2.5, 0.15));
        angle += velocity * dt;
        spinning = true;
      }
    }
    if (phase === "celebrate") {
      const t = phaseTime;
      if (t >= CELEBRATE_S) {
        phase = "float";
        phaseTime = 0;
      } else {
        // The claws go up fast, wave, and come down at the end; the crab hops twice meanwhile.
        raise = smooth(t / 0.35) * (1 - smooth((t - (CELEBRATE_S - 0.6)) / 0.6));
        const hop = t - 0.3;
        if (hop > 0 && hop < 1.4) jump = Math.abs(Math.sin((Math.PI * hop) / 0.7)) * 0.9;
        ax = Math.sin(time * 9) * 0.03 * raise;
        if (!confettiSpawned && t >= CONFETTI_AT_S) {
          confettiSpawned = true;
          spawnConfetti(cell, cw / 2, ch / 2 - 5 * cell);
        }
      }
    }
    if (phase === "float") {
      jump = Math.sin(time * 1.2) * 0.09 * p;
      ax = Math.sin(time * 0.8) * 0.035 * p;
    }
    // The twirl turns around the vertical axis; while it floats the crab only sways a little.
    const ay = spinning ? angle : phase === "float" ? Math.sin(time * 0.7) * 0.035 * p : 0;

    const originX = cw / 2;
    const originY = ch / 2 - jump * cell;
    const depth = 7.5 * cell;
    const c = Math.cos(ax);
    const s = Math.sin(ax);
    const cy = Math.cos(ay);
    const sy2 = Math.sin(ay);
    const rendered: { q: (typeof cells)[number]; x: number; y: number; size: number; z: number }[] = [];

    for (const q of cells) {
      let x = (q.x - 7.5) * cell;
      let y = (q.y - 5.5) * cell;
      let dx = 0;
      let dy = 0;
      const n = Math.sin(time * 1.5 + q.seed * 0.11) * 0.5 + Math.cos(time * 0.85 + q.seed * 0.07) * 0.3 + Math.sin(time * 2.2 + q.seed * 0.03) * 0.2;
      if (phase === "float") {
        dx = n * 0.1 * p * cell;
        dy = Math.cos(time * 1.3 + q.seed * 0.09) * 0.09 * p * cell;
      }
      if (phase === "bounce") {
        if (q.claw) dx += (q.x < 8 ? -1 : 1) * Math.sin(time * 4.1) * 0.16 * p * cell;
        if (q.leg) dx += Math.sin(time * 5.5 + q.x) * 0.12 * p * cell;
      }
      if (raise > 0 && q.claw) {
        const side = q.x < 8 ? -1 : 1;
        dy -= raise * 3.4 * cell;
        dx += side * raise * 0.7 * cell;
        dy += Math.sin(time * 13 + side) * 0.3 * cell * raise;
        dx += side * Math.sin(time * 11) * 0.15 * cell * raise;
      }
      if (spinning && (q.claw || q.leg)) {
        const lag = DRAG * (q.claw ? 1 : 0.85) * velocity * 0.1;
        dx += (y / cell) * lag * cell;
        dy -= (x / cell) * lag * cell;
        dx += Math.sin(time * velocity * 0.8 + q.seed * 0.035) * 0.16 * DRAG * cell;
        dy += Math.cos(time * velocity * 0.8 + q.seed * 0.035) * 0.13 * DRAG * cell;
      }
      x = (x + dx) * sx;
      y = (y + dy) * sy;
      const rx = cy * x;
      const rz = -sy2 * x;
      const ry = c * y - s * rz;
      const rz2 = s * y + c * rz;
      const persp = depth / (depth - rz2);
      rendered.push({ q, x: originX + rx * persp, y: originY + ry * persp, size: cell * 0.945 * persp, z: rz2 });
    }

    // Back-facing pixels first.
    rendered.sort((a, b) => a.z - b.z);
    for (const r of rendered) {
      ctx.globalAlpha = r.q.eye ? 1 : still ? 1 : 0.94 + 0.06 * Math.sin(time * 1.2 + r.q.seed);
      ctx.fillStyle = r.q.eye ? eye : body;
      ctx.fillRect(r.x - r.size / 2, r.y - r.size / 2, r.size, r.size);
    }

    // Confetti in front of the crab: it flies up and out, falls, and fades.
    if (confetti.length) {
      for (const k of confetti) {
        k.age += dt;
        k.vy += 45 * cell * dt;
        k.vx *= Math.exp(-1.6 * dt);
        k.x += k.vx * dt;
        k.y += k.vy * dt;
        k.rot += k.spin * dt;
      }
      confetti = confetti.filter((k) => k.age < k.life);
      for (const k of confetti) {
        ctx.globalAlpha = Math.min(1, (k.life - k.age) / 0.5);
        ctx.fillStyle = k.color;
        ctx.save();
        ctx.translate(k.x, k.y);
        ctx.rotate(k.rot);
        ctx.fillRect(-k.size / 2, -k.size / 2, k.size, k.size);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  onMount(() => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Someone who asked for less motion gets the crab standing still.
    const calm = matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      frame(ctx, Math.min((now - last) / 1000, 0.035), false);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      if (calm.matches) frame(ctx, 0, true);
      else {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    start();
    calm.addEventListener("change", start);
    const resized = new ResizeObserver(() => calm.matches && frame(ctx, 0, true));
    resized.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      calm.removeEventListener("change", start);
      resized.disconnect();
    };
  });
</script>

<canvas bind:this={canvas} class="-my-4 block aspect-[4/3] w-60 max-w-full" aria-hidden="true"></canvas>

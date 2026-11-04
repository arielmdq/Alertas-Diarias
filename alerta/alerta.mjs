// BuscaOlas - alerta por Telegram cuando hay ventanas buenas para surfear.
// Usa la misma lógica que script.js de la app (viento, energía y ventanas).
// Requiere Node 18+ (fetch incluido). No necesita dependencias.

const CONFIG = {
  lat: -38.0055,
  lon: -57.5426,
  timezone: "America/Argentina/Buenos_Aires",
};

const ART_OFFSET_H = 3; // Argentina = UTC-3 todo el año (sin horario de verano)
const APP_URL = "https://buscaolas.netlify.app/";

const { OPENWEATHER_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const OFFSET = Number(process.env.OFFSET || 1); // 0 = hoy, 1 = mañana
const SIEMPRE = process.env.SIEMPRE === "1"; // 1 = mandar mensaje aunque no haya ventanas (para pruebas)
const INCLUIR_REGULARES = process.env.INCLUIR_REGULARES === "1"; // 1 = avisar también ventanas amarillas

for (const [k, v] of Object.entries({ OPENWEATHER_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID })) {
  if (!v) {
    console.error(`Falta la variable de entorno ${k}`);
    process.exit(1);
  }
}
if (!Number.isInteger(OFFSET) || OFFSET < 0 || OFFSET > 4) {
  console.error("OFFSET debe ser un entero entre 0 y 4");
  process.exit(1);
}

/***********************
 * UTILIDADES (copiadas de la app)
 ***********************/
const pad = (n) => String(n).padStart(2, "0");

function gradosANombre(g) {
  if (g == null || isNaN(g)) return "-";
  const d = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
  return d[Math.round((((g % 360) + 360) % 360) / 22.5) % 16];
}

function clasificarEnergia(E) {
  if (E < 40) return "Muy Débil";
  if (E < 70) return "Débil";
  if (E < 150) return "Media";
  if (E < 250) return "Fuerte";
  return "Muy Fuerte";
}

function esVientoBueno(dir, vel) {
  const buenos = ["NNO", "NO", "ONO", "O", "OSO"];
  const este = ["NE", "ENE", "E", "ESE", "SE", "SSE"];

  if (dir === "N" && vel < 20) return true;
  if (dir === "SO" && vel < 20) return true;
  if (dir === "SSO" && vel < 20) return true;
  if (buenos.includes(dir) && vel <= 45) return true;
  if (este.includes(dir) && vel < 12) return true;

  return false;
}

async function getJSON(url, nombre) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${nombre} respondió ${r.status}`);
  return r.json();
}

/***********************
 * FECHA OBJETIVO (en hora argentina)
 ***********************/
const ahoraART = new Date(Date.now() - ART_OFFSET_H * 3600 * 1000);
const horaActual = ahoraART.getUTCHours();
const dia = new Date(
  Date.UTC(ahoraART.getUTCFullYear(), ahoraART.getUTCMonth(), ahoraART.getUTCDate() + OFFSET)
);
const Y = dia.getUTCFullYear();
const M = dia.getUTCMonth();
const D = dia.getUTCDate();
const fechaISO = `${Y}-${pad(M + 1)}-${pad(D)}`;

/***********************
 * DATOS -> FILAS HORARIAS (5 a 19 hs)
 ***********************/
async function obtenerFilas() {
  const urlOlas =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${CONFIG.lat}&longitude=${CONFIG.lon}` +
    `&hourly=wave_height,wave_period,wave_direction&timezone=${encodeURIComponent(CONFIG.timezone)}`;

  const urlViento =
    `https://api.openweathermap.org/data/2.5/forecast?lat=${CONFIG.lat}&lon=${CONFIG.lon}` +
    `&units=metric&appid=${OPENWEATHER_KEY}`;

  const [olas, viento] = await Promise.all([
    getJSON(urlOlas, "Open-Meteo Marine"),
    getJSON(urlViento, "OpenWeather"),
  ]);

  const horas = Array.from({ length: 15 }, (_, i) => i + 5).filter(
    (h) => OFFSET !== 0 || h > horaActual
  );

  return horas
    .map((h) => {
      const idx = olas.hourly.time.indexOf(`${fechaISO}T${pad(h)}:00`);
      if (idx === -1) return null;

      const altura = Number(olas.hourly.wave_height[idx]);
      const periodo = Number(olas.hourly.wave_period[idx]);
      const swellDeg = olas.hourly.wave_direction[idx];

      // instante de esa hora argentina, expresado en UTC
      const objetivo = Date.UTC(Y, M, D, h + ART_OFFSET_H);

      const vientoCercano = viento.list.reduce(
        (p, c) => {
          const diff = Math.abs(objetivo - c.dt * 1000);
          return diff < p.diff
            ? { diff, vel: Math.round(c.wind.speed * 3.6), dir: gradosANombre(c.wind.deg) }
            : p;
        },
        { diff: Infinity, vel: 0, dir: "-" }
      );

      const energia = Math.round(altura * altura * periodo * 10);

      let color;
      if (!esVientoBueno(vientoCercano.dir, vientoCercano.vel)) color = "roja";
      else if (energia < 70) color = "amarilla";
      else color = "verde";

      return {
        hora: h,
        energia,
        vientoDir: vientoCercano.dir,
        vientoVel: vientoCercano.vel,
        swellDir: gradosANombre(swellDeg),
        altura,
        periodo,
        color,
      };
    })
    .filter(Boolean);
}

/***********************
 * VENTANAS (mismo criterio que la app: 2+ horas seguidas del mismo color)
 ***********************/
function construirVentanas(filas) {
  const candidatas = filas.filter((f) => f.color !== "roja");
  const ventanas = [];
  let bloque = [];

  candidatas.forEach((f) => {
    if (!bloque.length || (f.hora === bloque.at(-1).hora + 1 && f.color === bloque.at(-1).color)) {
      bloque.push(f);
    } else {
      if (bloque.length > 1) ventanas.push(bloque);
      bloque = [f];
    }
  });
  if (bloque.length > 1) ventanas.push(bloque);

  return ventanas;
}

function resumirVentana(v) {
  const prom = (campo) => v.reduce((a, b) => a + b[campo], 0) / v.length;

  const conteo = {};
  v.forEach((f) => (conteo[f.swellDir] = (conteo[f.swellDir] || 0) + 1));
  const swellDir = Object.entries(conteo).sort((a, b) => b[1] - a[1])[0][0];

  const energia = Math.round(prom("energia"));

  return {
    color: v[0].color,
    rango: `${v[0].hora}–${v.at(-1).hora}h`,
    energia,
    energiaTxt: clasificarEnergia(energia),
    vientoDir: v[0].vientoDir,
    vientoVel: Math.round(prom("vientoVel")),
    swellDir,
    altura: prom("altura").toFixed(1),
    periodo: prom("periodo").toFixed(1),
  };
}

/***********************
 * TELEGRAM
 ***********************/
async function enviarTelegram(texto) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: texto,
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    throw new Error(`Telegram respondió ${r.status}: ${await r.text()}`);
  }
}

/***********************
 * MAIN
 ***********************/
const filas = await obtenerFilas();
let ventanas = construirVentanas(filas).map(resumirVentana);

if (!INCLUIR_REGULARES) ventanas = ventanas.filter((v) => v.color === "verde");

const etiquetaDia =
  OFFSET === 0
    ? "Hoy"
    : OFFSET === 1
    ? "Mañana"
    : dia.toLocaleDateString("es-AR", { weekday: "long", timeZone: "UTC" });

const fechaTxt = dia.toLocaleDateString("es-AR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

console.log(`Chequeo para ${fechaISO} (offset ${OFFSET}): ${filas.length} horas, ${ventanas.length} ventanas`);

if (!ventanas.length) {
  if (SIEMPRE) {
    await enviarTelegram(`🌊 ${etiquetaDia} (${fechaTxt}): sin ventanas buenas.\n${APP_URL}`);
    console.log("Enviado mensaje de prueba (sin ventanas).");
  }
  process.exit(0);
}

const lineas = ventanas.map((v) => {
  const icono = v.color === "verde" ? "🟢" : "🟡";
  return (
    `${icono} ${v.rango} · viento ${v.vientoDir} ${v.vientoVel} km/h\n` +
    `    swell ${v.swellDir} ${v.altura} m · ${v.periodo} s · energía ${v.energia} (${v.energiaTxt})`
  );
});

const titulo =
  ventanas.length === 1
    ? `🌊 ${etiquetaDia} hay ventana para surfear`
    : `🌊 ${etiquetaDia} hay ${ventanas.length} ventanas para surfear`;

await enviarTelegram(`${titulo}\n${fechaTxt}\n\n${lineas.join("\n\n")}\n\n${APP_URL}`);
console.log("Alerta enviada por Telegram.");

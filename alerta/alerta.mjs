// BuscaOlas - alerta por Telegram con TODAS las ventanas buenas de los próximos días.
// Usa la misma lógica que script.js de la app (viento, energía y ventanas).
// Requiere Node 18+ (fetch incluido). No necesita dependencias.
//
// Variables opcionales (se pasan como variables de entorno):
//   OFFSET             primer día a revisar: 0 = hoy, 1 = mañana (lo define el workflow)
//   HASTA              último día a revisar, contando desde hoy (por defecto 4)
//   INCLUIR_REGULARES  1 = incluir también ventanas amarillas
//   SIEMPRE            1 = mandar mensaje aunque no haya ventanas (para pruebas)
//   DRY_RUN            1 = mostrar el mensaje en pantalla sin mandarlo a Telegram

const CONFIG = {
  lat: -38.0055,
  lon: -57.5426,
  timezone: "America/Argentina/Buenos_Aires",
};

const ART_OFFSET_H = 3; // Argentina = UTC-3 todo el año (sin horario de verano)
const APP_URL = "https://buscaolas.netlify.app/";
const MAX_VIENTO_DIFF_MS = 3 * 3600 * 1000; // OpenWeather da datos cada 3 hs y llega a ~5 días

const { OPENWEATHER_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const DRY_RUN = process.env.DRY_RUN === "1";
const DESDE = Number(process.env.OFFSET || 1);
const HASTA = Number(process.env.HASTA || 4);
const SIEMPRE = process.env.SIEMPRE === "1";
const INCLUIR_REGULARES = process.env.INCLUIR_REGULARES === "1";

const requeridas = DRY_RUN
  ? { OPENWEATHER_KEY }
  : { OPENWEATHER_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID };

for (const [k, v] of Object.entries(requeridas)) {
  if (!v) {
    console.error(`Falta la variable de entorno ${k}`);
    process.exit(1);
  }
}
if (!Number.isInteger(DESDE) || !Number.isInteger(HASTA) || DESDE < 0 || HASTA > 6 || DESDE > HASTA) {
  console.error("OFFSET y HASTA deben ser enteros entre 0 y 6, con OFFSET <= HASTA");
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
 * FECHAS (en hora argentina)
 ***********************/
const ahoraART = new Date(Date.now() - ART_OFFSET_H * 3600 * 1000);
const horaActual = ahoraART.getUTCHours();
const Y0 = ahoraART.getUTCFullYear();
const M0 = ahoraART.getUTCMonth();
const D0 = ahoraART.getUTCDate();

const diaDe = (offset) => new Date(Date.UTC(Y0, M0, D0 + offset));

/***********************
 * DATOS
 ***********************/
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

/***********************
 * FILAS HORARIAS DE UN DÍA (5 a 19 hs)
 ***********************/
function filasDelDia(offset) {
  const dia = diaDe(offset);
  const Y = dia.getUTCFullYear();
  const M = dia.getUTCMonth();
  const D = dia.getUTCDate();
  const fechaISO = `${Y}-${pad(M + 1)}-${pad(D)}`;

  const horas = Array.from({ length: 15 }, (_, i) => i + 5).filter(
    (h) => offset !== 0 || h > horaActual
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

      // Sin pronóstico de viento para esa hora (más allá de ~5 días): no se evalúa
      if (vientoCercano.diff > MAX_VIENTO_DIFF_MS) return null;

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
async function enviar(texto) {
  if (DRY_RUN) {
    console.log("----- (DRY_RUN) mensaje que se enviaría -----");
    console.log(texto);
    console.log("---------------------------------------------");
    return;
  }

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
const mayus = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function tituloDia(offset) {
  const fecha = mayus(
    diaDe(offset).toLocaleDateString("es-AR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    })
  );
  if (offset === 0) return `Hoy · ${fecha}`;
  if (offset === 1) return `Mañana · ${fecha}`;
  return fecha;
}

const dias = [];
for (let off = DESDE; off <= HASTA; off++) {
  let ventanas = construirVentanas(filasDelDia(off)).map(resumirVentana);
  if (!INCLUIR_REGULARES) ventanas = ventanas.filter((v) => v.color === "verde");
  if (ventanas.length) dias.push({ off, ventanas });
}

const total = dias.reduce((a, d) => a + d.ventanas.length, 0);
console.log(`Chequeo días ${DESDE} a ${HASTA}: ${dias.length} días con ventanas, ${total} ventanas en total`);

if (!total) {
  if (SIEMPRE) {
    const n = HASTA - DESDE + 1;
    await enviar(`🌊 Sin ventanas buenas en ${n === 1 ? "el día revisado" : `los próximos ${n} días`}.\n${APP_URL}`);
    console.log("Enviado mensaje de prueba (sin ventanas).");
  }
  process.exit(0);
}

const bloques = dias.map(({ off, ventanas }) => {
  const lineas = ventanas.map((v) => {
    const icono = v.color === "verde" ? "🟢" : "🟡";
    return (
      `${icono} ${v.rango} · viento ${v.vientoDir} ${v.vientoVel} km/h\n` +
      `    swell ${v.swellDir} ${v.altura} m · ${v.periodo} s · energía ${v.energia} (${v.energiaTxt})`
    );
  });
  return `📅 ${tituloDia(off)}\n${lineas.join("\n")}`;
});

const encabezado =
  total === 1
    ? "🌊 Hay 1 ventana para surfear"
    : `🌊 Hay ${total} ventanas para surfear en ${dias.length === 1 ? "1 día" : `${dias.length} días`}`;

// Telegram acepta hasta 4096 caracteres por mensaje: si hace falta, se parte por día.
const LIMITE = 3800;
const mensajes = [];
let actual = encabezado;
for (const b of bloques) {
  if ((actual + "\n\n" + b).length > LIMITE) {
    mensajes.push(actual);
    actual = b;
  } else {
    actual += "\n\n" + b;
  }
}
mensajes.push(actual + `\n\n${APP_URL}`);

for (const m of mensajes) await enviar(m);
console.log(`Alerta enviada (${mensajes.length} mensaje${mensajes.length === 1 ? "" : "s"}).`);

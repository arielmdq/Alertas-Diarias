// Alertas por Telegram: ventanas de olas, tramos de viento bueno y movimientos de precios.
// Los valores que se pueden cambiar están en config.mjs (no hace falta tocar este archivo).
// Requiere Node 18+ (fetch incluido). No necesita dependencias.
//
// Variables de entorno (las pone el workflow):
//   OPENWEATHER_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID   (secrets de GitHub)
//   SIEMPRE=1   manda mensajes aunque no haya novedades (para probar)
//   DRY_RUN=1   muestra los mensajes en pantalla sin mandarlos ni guardar estado
//   SOLO=olas | SOLO=precios   corre solo una de las dos partes

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.mjs";

const { OPENWEATHER_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const DRY_RUN = process.env.DRY_RUN === "1";
const SIEMPRE = process.env.SIEMPRE === "1";
const SOLO = process.env.SOLO || "";
const ESTADO_PATH =
  process.env.ESTADO_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), "estado.json");

const O = CONFIG.olas;
const P = CONFIG.precios;
const APP_URL = CONFIG.appUrl;
const ART_OFFSET_H = 3; // Argentina = UTC-3 todo el año (sin horario de verano)
const MAX_VIENTO_DIFF_MS = 3 * 3600 * 1000; // OpenWeather da datos cada 3 hs y llega a ~5 días

const hacerOlas = SOLO !== "precios";
const hacerPrecios = SOLO !== "olas";
let huboErrores = false;

const faltan = [];
if (hacerOlas && !OPENWEATHER_KEY) faltan.push("OPENWEATHER_KEY");
if (!DRY_RUN && !TELEGRAM_TOKEN) faltan.push("TELEGRAM_TOKEN");
if (!DRY_RUN && !TELEGRAM_CHAT_ID) faltan.push("TELEGRAM_CHAT_ID");
if (faltan.length) {
  console.error(`Faltan variables de entorno: ${faltan.join(", ")}`);
  process.exit(1);
}
if (!Number.isInteger(O.diasAdelante) || O.diasAdelante < 0 || O.diasAdelante > 6) {
  console.error("config.mjs: olas.diasAdelante debe ser un entero entre 0 y 6");
  process.exit(1);
}

/***********************
 * UTILIDADES
 ***********************/
const pad = (n) => String(n).padStart(2, "0");

async function getJSON(url, nombre, opciones = {}) {
  const r = await fetch(url, opciones);
  if (!r.ok) throw new Error(`${nombre} respondió ${r.status}`);
  return r.json();
}

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
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram respondió ${r.status}: ${await r.text()}`);
}

// Manda una línea por renglón. Telegram acepta hasta 4096 caracteres por mensaje:
// si hace falta, se parte en varios mensajes.
async function enviarLineas(lineas) {
  const LIMITE = 3800;
  const mensajes = [];
  let actual = "";
  for (const l of lineas) {
    if (actual && (actual + "\n" + l).length > LIMITE) {
      mensajes.push(actual);
      actual = l;
    } else {
      actual = actual ? actual + "\n" + l : l;
    }
  }
  if (actual) mensajes.push(actual);
  for (const m of mensajes) await enviar(m);
  return mensajes.length;
}

function leerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ESTADO_PATH, "utf8"));
  } catch {
    return {};
  }
}

/***********************
 * FECHAS (hora argentina)
 ***********************/
const ahoraART = new Date(Date.now() - ART_OFFSET_H * 3600 * 1000);
const horaActual = ahoraART.getUTCHours();
const Y0 = ahoraART.getUTCFullYear();
const M0 = ahoraART.getUTCMonth();
const D0 = ahoraART.getUTCDate();

const diaDe = (offset) => new Date(Date.UTC(Y0, M0, D0 + offset));
const isoDe = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fechaHoyART = isoDe(ahoraART);

/***********************
 * OLAS Y VIENTO (misma lógica que script.js de la app)
 ***********************/
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

const esVientoBueno = (dir, vel) => O.reglasViento.some((r) => r.direcciones.includes(dir) && vel <= r.maxKmh);

// Filas horarias de un día: viento, olas y color (roja / amarilla / verde)
function filasDelDia(offset, fechaISO, olas, viento) {
  const dia = diaDe(offset);
  const Y = dia.getUTCFullYear();
  const M = dia.getUTCMonth();
  const D = dia.getUTCDate();

  const horas = Array.from({ length: O.horaFin - O.horaInicio + 1 }, (_, i) => O.horaInicio + i).filter(
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
      else if (energia < O.energiaMinimaVerde) color = "amarilla";
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

// Bloques de horas seguidas que cumplen una condición
function agruparConsecutivas(filas, acepta) {
  const bloques = [];
  let b = [];
  for (const f of filas) {
    if (acepta(f) && (!b.length || f.hora === b.at(-1).hora + 1)) {
      b.push(f);
    } else {
      if (b.length) bloques.push(b);
      b = acepta(f) ? [f] : [];
    }
  }
  if (b.length) bloques.push(b);
  return bloques;
}

function resumir(b, tipo, fecha) {
  const col = (campo) => b.map((f) => f[campo]);
  const prom = (campo) => col(campo).reduce((a, x) => a + x, 0) / b.length;

  const conteo = {};
  b.forEach((f) => (conteo[f.swellDir] = (conteo[f.swellDir] || 0) + 1));
  const swellDir = Object.entries(conteo).sort((x, y) => y[1] - x[1])[0][0];

  return {
    tipo,
    fecha,
    desde: b[0].hora,
    hasta: b.at(-1).hora,
    dirs: [...new Set(col("vientoDir"))],
    velMin: Math.min(...col("vientoVel")),
    velMax: Math.max(...col("vientoVel")),
    alturaMin: Math.min(...col("altura")),
    alturaMax: Math.max(...col("altura")),
    periodo: prom("periodo"),
    energiaMin: Math.min(...col("energia")),
    energiaMax: Math.max(...col("energia")),
    energiaProm: Math.round(prom("energia")),
    swellDir,
  };
}

function itemsDelDia(filas, fecha) {
  const items = [];

  // 🟢 Ventanas: viento bueno + energía suficiente
  agruparConsecutivas(filas, (f) => f.color === "verde")
    .filter((b) => b.length >= O.minHorasVentana)
    .forEach((b) => items.push(resumir(b, "verde", fecha)));

  // 🌬️ Tramos de viento bueno (con cualquier energía). Si todo el tramo ya es una
  // ventana verde, no se repite.
  if (O.avisarVientoBueno) {
    agruparConsecutivas(filas, (f) => f.color !== "roja")
      .filter((b) => b.length >= O.minHorasViento)
      .filter((b) => !(b.every((f) => f.color === "verde") && b.length >= O.minHorasVentana))
      .forEach((b) => items.push(resumir(b, "viento", fecha)));
  }

  // verdes primero, después por hora
  return items.sort((a, b) => (a.tipo === b.tipo ? a.desde - b.desde : a.tipo === "verde" ? -1 : 1));
}

function rangoNum(min, max, dec = 0) {
  const a = min.toFixed(dec);
  const b = max.toFixed(dec);
  return a === b ? a : `${a}–${b}`;
}

const DIAS_SEMANA = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// Plantillas de los mensajes (se cambian en config.mjs; estos son los valores por defecto)
const MSG = {
  ventana: "{dia} {fecha} 🟢 {horas}h energía {energia} ({clase})",
  viento: "{dia} {fecha} viento bueno {horas}h · {viento} {vel} km/h",
  marcaNuevo: "🆕 ",
  ...(O.mensajes ?? {}),
};

// Una línea por ventana / tramo, armada con la plantilla correspondiente
function lineaItem(it, marcar) {
  const [y, m, d] = it.fecha.split("-").map(Number);
  const valores = {
    dia: DIAS_SEMANA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
    fecha: `${d}/${m}`,
    horas: it.desde === it.hasta ? `${it.desde}` : `${it.desde}–${it.hasta}`,
    desde: it.desde,
    hasta: it.hasta,
    energia: rangoNum(it.energiaMin, it.energiaMax),
    clase: clasificarEnergia(it.energiaProm),
    viento: it.dirs.join("/"),
    vel: rangoNum(it.velMin, it.velMax),
    swell: it.swellDir,
    altura: rangoNum(it.alturaMin, it.alturaMax, 1),
    periodo: it.periodo.toFixed(1),
  };
  const plantilla = it.tipo === "verde" ? MSG.ventana : MSG.viento;
  const linea = plantilla.replace(/\{(\w+)\}/g, (txt, k) => (k in valores ? valores[k] : txt));
  return (marcar && it.nuevo ? MSG.marcaNuevo : "") + linea;
}

async function seccionOlas(estado, nuevo) {
  const urlOlas =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${O.lat}&longitude=${O.lon}` +
    `&hourly=wave_height,wave_period,wave_direction&timezone=${encodeURIComponent("America/Argentina/Buenos_Aires")}`;
  const urlViento =
    `https://api.openweathermap.org/data/2.5/forecast?lat=${O.lat}&lon=${O.lon}` +
    `&units=metric&appid=${OPENWEATHER_KEY}`;

  const [olas, viento] = await Promise.all([
    getJSON(urlOlas, "Open-Meteo Marine"),
    getJSON(urlViento, "OpenWeather"),
  ]);

  const dias = [];
  for (let off = 0; off <= O.diasAdelante; off++) {
    const fecha = isoDe(diaDe(off));
    const items = itemsDelDia(filasDelDia(off, fecha, olas, viento), fecha);
    if (items.length) dias.push({ off, items });
  }

  // ¿Qué es nuevo? Un tramo es "nuevo" si antes no había ninguno del mismo tipo que se superponga
  // en ese día. (Así, si una ventana se acorta porque el día avanza, no cuenta como nueva.)
  const previos = estado.olas?.items ?? [];
  const esNuevo = (it) =>
    !previos.some((p) => p.fecha === it.fecha && p.tipo === it.tipo && p.desde <= it.hasta && it.desde <= p.hasta);

  const todos = dias.flatMap((d) => d.items);
  todos.forEach((it) => (it.nuevo = esNuevo(it)));
  const hayNuevos = todos.some((it) => it.nuevo);

  const nV = todos.filter((i) => i.tipo === "verde").length;
  const nW = todos.filter((i) => i.tipo === "viento").length;
  console.log(`Olas: ${nV} ventanas, ${nW} tramos de viento bueno, ${todos.filter((i) => i.nuevo).length} nuevos`);

  if (todos.length) {
    if (SIEMPRE || !O.soloSiHayNovedad || hayNuevos) {
      // Solo se marcan los 🆕 cuando el mensaje mezcla cosas nuevas con otras que ya te habían avisado
      const marcar = hayNuevos && todos.some((it) => !it.nuevo);
      const ordenados = [...todos].sort(
        (a, b) =>
          a.fecha.localeCompare(b.fecha) || a.desde - b.desde || (a.tipo === b.tipo ? 0 : a.tipo === "verde" ? -1 : 1)
      );
      const n = await enviarLineas(ordenados.map((it) => lineaItem(it, marcar)));
      console.log(`Olas: alerta enviada (${n} mensaje${n === 1 ? "" : "s"}).`);
    }
  } else if (SIEMPRE) {
    await enviar(`🌊 Sin ventanas ni viento bueno en los próximos ${O.diasAdelante + 1} días.\n${APP_URL}`);
    console.log("Olas: enviado mensaje de prueba (sin ventanas).");
  }

  // El estado se guarda después de enviar: si Telegram falla, el próximo chequeo reintenta.
  // Si un tramo ya estaba, se guarda la unión de horas: así, cuando "hoy" se va achicando con el
  // paso de las horas, el archivo no cambia y no se generan commits de más.
  nuevo.olas = {
    items: todos.map((it) => {
      const sol = previos.filter(
        (p) => p.fecha === it.fecha && p.tipo === it.tipo && p.desde <= it.hasta && it.desde <= p.hasta
      );
      return {
        tipo: it.tipo,
        fecha: it.fecha,
        desde: Math.min(it.desde, ...sol.map((p) => p.desde)),
        hasta: Math.max(it.hasta, ...sol.map((p) => p.hasta)),
      };
    }),
  };
}

/***********************
 * PRECIOS
 ***********************/
const UA = { headers: { "User-Agent": "Mozilla/5.0 (compatible; alertas-diarias)" } };

async function preciosCoingecko(activos) {
  try {
    const ids = activos.map((a) => a.id).join(",");
    const j = await getJSON(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`,
      "CoinGecko",
      UA
    );
    return activos.map((a) => {
      const d = j[a.id];
      if (!d || d.usd == null || d.usd_24h_change == null) return { activo: a, error: `CoinGecko sin datos para "${a.id}"` };
      return { activo: a, precio: d.usd, variacion: d.usd_24h_change, fecha: fechaHoyART, base: "24 h" };
    });
  } catch (e) {
    return activos.map((a) => ({ activo: a, error: e.message }));
  }
}

async function precioYahoo(a) {
  try {
    // Yahoo tiene dos servidores equivalentes: si falla el primero, prueba con el segundo
    let j;
    let ultimoError;
    for (const host of ["query1", "query2"]) {
      try {
        j = await getJSON(
          `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(a.id)}?range=5d&interval=1d`,
          "Yahoo",
          UA
        );
        break;
      } catch (e) {
        ultimoError = e;
      }
    }
    if (!j) throw ultimoError;
    const r = j.chart?.result?.[0];
    if (!r?.timestamp) throw new Error(`Yahoo sin datos para "${a.id}"`);
    const cierres = r.timestamp
      .map((t, i) => [t, r.indicators.quote[0].close[i]])
      .filter(([, c]) => c != null);
    if (cierres.length < 2) throw new Error(`Yahoo con pocos datos para "${a.id}"`);

    const [tUlt, ult] = cierres.at(-1);
    const [, ant] = cierres.at(-2);
    const fecha = isoDe(new Date(tUlt * 1000 - ART_OFFSET_H * 3600 * 1000));
    return { activo: a, precio: ult, variacion: (ult / ant - 1) * 100, fecha, base: "vs cierre anterior" };
  } catch (e) {
    return { activo: a, error: e.message };
  }
}

// Avisa una vez por nivel y por día: a ±2%, y de nuevo si llega a ±4%, ±6%...
// Si el precio oscila alrededor de un nivel, no repite el aviso.
function evaluarNivel(previo, fecha, variacion, paso) {
  const nivel = Math.trunc(variacion / paso);
  const st = previo && previo.fecha === fecha ? { ...previo } : { fecha, subio: 0, bajo: 0 };
  let alertar = false;
  if (nivel > 0 && nivel > st.subio) {
    st.subio = nivel;
    alertar = true;
  }
  if (nivel < 0 && -nivel > st.bajo) {
    st.bajo = -nivel;
    alertar = true;
  }
  return { alertar, st };
}

const fmtPct = (v) => `${v.toLocaleString("es-AR", { signDisplay: "always", maximumFractionDigits: 1 })}%`;
function fmtPrecio(p, moneda) {
  const dec = p >= 1000 ? 0 : 2;
  const n = p.toLocaleString("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return `${moneda === "USD" ? "US$" : "$"} ${n}`;
}
const lineaPrecio = (r) =>
  `${r.variacion >= 0 ? "📈" : "📉"} ${r.activo.nombre} ${fmtPct(r.variacion)} · ${fmtPrecio(r.precio, r.activo.moneda)}  (${r.base})`;

async function seccionPrecios(estado, nuevo) {
  const paso = P.umbralPorcentaje;
  const cripto = P.activos.filter((a) => a.fuente === "coingecko");
  const acciones = P.activos.filter((a) => a.fuente === "yahoo");
  const otros = P.activos.filter((a) => a.fuente !== "coingecko" && a.fuente !== "yahoo");

  const resultados = [
    ...(cripto.length ? await preciosCoingecko(cripto) : []),
    ...(await Promise.all(acciones.map(precioYahoo))),
    ...otros.map((a) => ({ activo: a, error: `fuente desconocida "${a.fuente}" (usar "coingecko" o "yahoo")` })),
  ];
  const porNombre = new Map(resultados.map((r) => [r.activo.nombre, r]));

  const alertas = [];
  const fallidos = [];
  const niveles = {};
  for (const a of P.activos) {
    const r = porNombre.get(a.nombre);
    if (r.error) {
      console.log(`::warning title=Precios::${a.nombre}: ${r.error}`);
      fallidos.push(r);
      continue;
    }
    const { alertar, st } = evaluarNivel(estado.precios?.[a.nombre], r.fecha, r.variacion, paso);
    niveles[a.nombre] = st;
    if (alertar) alertas.push(r);
  }
  console.log(`Precios: ${resultados.filter((r) => !r.error).length}/${P.activos.length} leídos, ${alertas.length} con alerta`);

  if (alertas.length) {
    await enviar(`📊 Activos con movimiento de ±${paso}% o más\n\n${alertas.map(lineaPrecio).join("\n")}`);
    console.log("Precios: alerta enviada.");
  } else if (SIEMPRE) {
    // Mensaje de prueba: muestra todos los activos y marca los que no se pudieron leer
    const lineas = P.activos.map((a) => {
      const r = porNombre.get(a.nombre);
      return r.error ? `⚠️ ${a.nombre}: sin datos` : lineaPrecio(r);
    });
    await enviar(`📊 Estado de activos (prueba, sin movimientos de ±${paso}%)\n\n${lineas.join("\n")}`);
    console.log("Precios: enviado mensaje de prueba.");
  }

  nuevo.precios = { ...(estado.precios ?? {}), ...niveles };

  // Un activo que no se pudo leer NO hace fallar el chequeo: te lo aviso por Telegram,
  // una sola vez por día por activo (así te enterás si un símbolo está mal o una fuente no responde).
  const avisados = estado.erroresAvisados ?? {};
  const siguen = {};
  const porAvisar = [];
  for (const r of fallidos) {
    const n = r.activo.nombre;
    if (avisados[n] === fechaHoyART) siguen[n] = fechaHoyART;
    else porAvisar.push(r);
  }
  if (porAvisar.length) {
    await enviar(
      `⚠️ No pude leer ${porAvisar.length === 1 ? "este activo" : "estos activos"}:\n` +
        `${porAvisar.map((r) => `• ${r.activo.nombre}: ${r.error}`).join("\n")}\n` +
        `Si el símbolo está mal, corregilo en config.mjs. Te aviso una vez por día.`
    );
    porAvisar.forEach((r) => (siguen[r.activo.nombre] = fechaHoyART));
  }
  if (Object.keys(siguen).length) nuevo.erroresAvisados = siguen;
  else delete nuevo.erroresAvisados;
}

/***********************
 * MAIN
 ***********************/
const estado = leerEstado();
const nuevo = JSON.parse(JSON.stringify(estado));

if (hacerOlas) {
  try {
    await seccionOlas(estado, nuevo);
  } catch (e) {
    console.error(`Olas: ${e.message}`);
    huboErrores = true;
  }
}
if (hacerPrecios) {
  try {
    await seccionPrecios(estado, nuevo);
  } catch (e) {
    console.error(`Precios: ${e.message}`);
    huboErrores = true;
  }
}

if (!DRY_RUN && JSON.stringify(estado) !== JSON.stringify(nuevo)) {
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(nuevo, null, 2) + "\n");
  console.log("Estado actualizado.");
}

process.exitCode = huboErrores ? 1 : 0;

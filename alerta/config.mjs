// =====================================================================
//  CONFIGURACIÓN DE LAS ALERTAS
//  Este es el único archivo que necesitás tocar para cambiar valores.
//  (Los horarios de los chequeos están en el workflow, ver abajo.)
//
//  Cómo editarlo en GitHub: abrí este archivo en tu repo, tocá el
//  lápiz ✏️, cambiá lo que quieras y tocá "Commit changes".
//  Cuidado: dejá las comillas, las comas y las llaves como están.
// =====================================================================

export const CONFIG = {
  // Link que aparece al final de los mensajes
  appUrl: "https://buscaolas.netlify.app/",

  // ───────────────────────── OLAS Y VIENTO ─────────────────────────
  olas: {
    // Lugar del pronóstico (Mar del Plata). Cambiá estos dos números si querés otro spot.
    lat: -38.0055,
    lon: -57.5426,

    // Cuántos días hacia adelante mira, contando desde hoy (0 = solo hoy).
    // Máximo 6, pero pasando de 4 el viento no tiene pronóstico confiable.
    diasAdelante: 4,

    // Horas del día que se evalúan (hora argentina). La app usa de 5 a 19.
    horaInicio: 5,
    horaFin: 19,

    // 🟢 VENTANA = viento bueno + olas con energía suficiente.
    // Cuántas horas seguidas hacen falta para que cuente como ventana:
    minHorasVentana: 2,
    // Energía mínima de las olas para que una hora sea 🟢 (si es menor, queda "regular").
    // Energía = altura² × período × 10. Referencia: 40 débil, 70 media, 150 fuerte.
    energiaMinimaVerde: 70,

    // 🌬️ TRAMOS DE VIENTO BUENO (aunque las olas sean chicas).
    // false = no avisa tramos de viento, solo las ventanas verdes.
    avisarVientoBueno: true,
    // Horas seguidas de viento bueno para que se avise:
    minHorasViento: 2,

    // true  = te escribe solo cuando aparece algo NUEVO (una ventana o tramo que antes no estaba).
    // false = te escribe en cada chequeo (5 veces por día) con todo lo que haya.
    soloSiHayNovedad: true,

    // FORMATO DE LOS MENSAJES: una línea por ventana 🟢 y una por tramo de viento bueno.
    // Podés cambiar el texto y mover o borrar los {marcadores}.
    // Marcadores disponibles:
    //   {dia}     Dom, Lun, Mar...          {fecha}   8/11
    //   {horas}   5–7                       {desde} {hasta}   hora de inicio y de fin
    //   {energia} 73–78                     {clase}   Media, Fuerte...
    //   {viento}  NO/NNO/N (direcciones)    {vel}     18–23 (en km/h)
    //   {swell}   SSE (dirección del swell) {altura}  1.2–1.5 (en m)    {periodo}  11.0 (en s)
    mensajes: {
      ventana: "{dia} {fecha} 🟢 {horas}h energía {energia} ({clase})",
      viento: "{dia} {fecha} viento bueno {horas}h · {viento} {vel} km/h",
      // Marca que se agrega adelante de lo nuevo, solo cuando el mensaje mezcla cosas nuevas y viejas
      marcaNuevo: "🆕 ",
    },

    // Qué se considera VIENTO BUENO. Es la misma regla que usa la app (script.js).
    // Si algún día la cambiás en la app, cambiala también acá.
    //   direcciones: de dónde sopla
    //   maxKmh: velocidad máxima en km/h, inclusive (19 = "menos de 20", 11 = "menos de 12")
    reglasViento: [
      { direcciones: ["N", "SO", "SSO"], maxKmh: 19 },
      { direcciones: ["NNO", "NO", "ONO", "O", "OSO"], maxKmh: 45 },
      { direcciones: ["NE", "ENE", "E", "ESE", "SE", "SSE"], maxKmh: 11 },
    ],
  },

  // ───────────────────────── PRECIOS ─────────────────────────
  precios: {
    // Avisa cuando un activo se mueve este porcentaje (hacia arriba o hacia abajo).
    // Ejemplo: 2 = avisa a ±2%. Si sigue moviéndose, avisa de nuevo a ±4%, ±6%, etc.
    // Como máximo una vez por nivel por día. Cambiá este número cuando quieras.
    umbralPorcentaje: 2,

    // Lista de activos. Para AGREGAR uno copiá una línea y cambiá los datos.
    // Para SACAR uno borrá su línea (o ponele // adelante).
    //
    //   nombre : cómo aparece en el mensaje (cualquier texto, sin repetir)
    //   fuente : "coingecko" para cripto, "yahoo" para acciones y CEDEARs
    //   id     : coingecko -> el id de la moneda (ej: "bitcoin", "ethereum", "solana")
    //            yahoo     -> el símbolo de Yahoo Finance (ej: "SPY.BA" es el CEDEAR en pesos,
    //                         "SPY" sería el ETF en dólares)
    //   moneda : "USD" o "ARS" (solo para mostrar el precio con el signo correcto)
    //
    // Variación que se mide: cripto = últimas 24 hs. Acciones = contra el cierre anterior.
    activos: [
      { nombre: "BTC", fuente: "coingecko", id: "bitcoin", moneda: "USD" },
      { nombre: "ETH", fuente: "coingecko", id: "ethereum", moneda: "USD" },
      { nombre: "SPY", fuente: "yahoo", id: "SPY.BA", moneda: "ARS" },
      { nombre: "GLD", fuente: "yahoo", id: "GLD.BA", moneda: "ARS" },
      { nombre: "VIST", fuente: "yahoo", id: "VIST", moneda: "USD" },
      { nombre: "YPF", fuente: "yahoo", id: "YPF", moneda: "USD" },
      { nombre: "NVDA", fuente: "yahoo", id: "NVDA", moneda: "USD" },
    ],
  },
};

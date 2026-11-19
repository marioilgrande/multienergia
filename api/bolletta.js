// Lettura automatica della bolletta (PDF) per il Comparatore Multienergia.
// L'AI (Gemini) ESTRAE soltanto i numeri scritti in bolletta: nessun prezzo e nessun
// calcolo nasce qui. Il confronto lo fa il comparatore con le sue formule, dopo che
// l'operatore ha controllato i campi compilati.
// Funzione Node (non Edge): leggere un PDF può richiedere 20-30 secondi (limite 60 s in vercel.json).

const MODELLI = [['gemini-2.5-flash', 32000], ['gemini-2.5-flash-lite', 18000]];
const MAX_PDF_BYTES = 3 * 1024 * 1024;          // il corpo delle funzioni Vercel è limitato a 4,5 MB (base64 +33%)
const ORIGINI_OK = [/^https:\/\/multienergia(-[a-z0-9-]+)?\.vercel\.app$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

// Limite semplice per istanza: evita che qualcuno consumi la quota AI a raffica.
const richieste = new Map();
function troppeRichieste(ip) {
  const ora = Date.now(), finestra = 10 * 60 * 1000, max = 20;
  const lista = (richieste.get(ip) || []).filter(t => ora - t < finestra);
  lista.push(ora);
  richieste.set(ip, lista);
  return lista.length > max;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    affidabile: { type: 'BOOLEAN' },
    note: { type: 'STRING', nullable: true },
    tipoCliente: { type: 'STRING', enum: ['domestico', 'business'] },
    intestatario: { type: 'STRING', nullable: true },
    fornitore: { type: 'STRING', nullable: true },
    nomeOffertaLuce: { type: 'STRING', nullable: true },
    nomeOffertaGas: { type: 'STRING', nullable: true },
    luce: {
      type: 'OBJECT', nullable: true,
      properties: {
        mesi: { type: 'ARRAY', items: { type: 'STRING' } },
        kwhFatturati: { type: 'NUMBER', nullable: true },
        quotaConsumiTotale: { type: 'NUMBER', nullable: true },
        quotaConsumiVendita: { type: 'NUMBER', nullable: true },
        quotaConsumiRete: { type: 'NUMBER', nullable: true },
        quotaFissaTotale: { type: 'NUMBER', nullable: true },
        quotaFissaVendita: { type: 'NUMBER', nullable: true },
        quotaFissaRete: { type: 'NUMBER', nullable: true },
        totaleBolletta: { type: 'NUMBER', nullable: true },
        consumoAnnuo: { type: 'NUMBER', nullable: true },
        spesaAnnua: { type: 'NUMBER', nullable: true },
        potenzaKw: { type: 'NUMBER', nullable: true }
      }
    },
    gas: {
      type: 'OBJECT', nullable: true,
      properties: {
        mesi: { type: 'ARRAY', items: { type: 'STRING' } },
        smcFatturati: { type: 'NUMBER', nullable: true },
        quotaConsumiTotale: { type: 'NUMBER', nullable: true },
        quotaConsumiVendita: { type: 'NUMBER', nullable: true },
        quotaConsumiRete: { type: 'NUMBER', nullable: true },
        quotaFissaTotale: { type: 'NUMBER', nullable: true },
        quotaFissaVendita: { type: 'NUMBER', nullable: true },
        quotaFissaRete: { type: 'NUMBER', nullable: true },
        totaleBolletta: { type: 'NUMBER', nullable: true },
        consumoAnnuo: { type: 'NUMBER', nullable: true },
        spesaAnnua: { type: 'NUMBER', nullable: true }
      }
    }
  },
  required: ['affidabile', 'tipoCliente']
};

const PROMPT = `Sei un assistente che legge una bolletta di energia (luce, gas o entrambe) del mercato italiano allegata come PDF.
Estrai SOLO i dati scritti nella bolletta, senza inventare né calcolare nulla. Prendi i valori dalla sezione "SCONTRINO DELL'ENERGIA" (standard ARERA), NON dagli "elementi di dettaglio".

Regole:
- "intestatario": nome e cognome dell'intestatario (cliente domestico) oppure la ragione sociale (Partita IVA), come scritto nell'intestazione. Se non leggibile, null.
- "tipoCliente": "business" se la fornitura è intestata a una Partita IVA / uso non domestico, altrimenti "domestico".
- "fornitore": il venditore attuale (es. Enel Energia, A2A, Edison). "nomeOffertaLuce"/"nomeOffertaGas": il nome dell'offerta attuale, se scritto.
- "mesi": i mesi di calendario coperti dal periodo di fatturazione di QUEL servizio, nel formato "AAAA-MM" (es. periodo 01/08/2026 - 30/09/2026 => ["2026-08","2026-09"]). Se il periodo inizia o finisce a metà mese, includi i mesi coperti per almeno metà.
- "kwhFatturati" (luce) / "smcFatturati" (gas): la quantità fatturata nel periodo.
- IMPORTI DELLO SCONTRINO: ogni voce ha un totale e poi due righe "di cui". Riporta le TRE cifre separatamente, ciascuna nel suo campo, copiando gli importi in euro (non i prezzi unitari):
  - "quotaConsumiTotale": il totale della riga "QUOTA CONSUMI"/"QUOTA PER CONSUMI".
  - "quotaConsumiVendita": la riga "di cui spesa per la vendita di energia elettrica" (luce) o "di cui spesa per la vendita di gas naturale" (gas) che sta sotto la quota consumi.
  - "quotaConsumiRete": la riga "di cui spesa per la rete e gli oneri generali di sistema" sotto la quota consumi.
  - "quotaFissaTotale", "quotaFissaVendita", "quotaFissaRete": le stesse tre cifre per la riga "QUOTA FISSA" (se la voce è "QUOTA FISSA E QUOTA POTENZA", usa solo la sotto-voce "Quota fissa" e le sue righe "di cui"; la quota potenza è tutta rete e non va nella vendita).
  - Esempio luce: "QUOTA CONSUMI 213,57 €", "Quota consumi 1.009 kWh 213,57 €", "di cui spesa per la vendita di energia elettrica 165,25 €", "di cui spesa per la rete e gli oneri 48,32 €" => quotaConsumiTotale 213.57, quotaConsumiVendita 165.25, quotaConsumiRete 48.32. "Quota fissa 28,02 €", "di cui spesa per la vendita 24,18 €", "di cui rete e oneri 3,84 €" => quotaFissaTotale 28.02, quotaFissaVendita 24.18, quotaFissaRete 3.84.
  - La vendita è SEMPRE minore del totale quando c'è una riga di rete: controlla che vendita + rete = totale.
- "totaleBolletta": il "Totale bolletta" del servizio nel periodo (IVA inclusa) SENZA il canone RAI: se c'è un "Totale da pagare" che aggiunge il canone RAI, prendi il "Totale bolletta" prima del canone. Se la bolletta è unica per luce e gas e il totale non è separabile, metti il totale solo nel servizio luce e null nel gas.
- "consumoAnnuo": il consumo annuo scritto in bolletta (kWh/anno per la luce come totale delle fasce F1+F2+F3, Smc/anno per il gas), se presente.
- "spesaAnnua": la "Spesa annua" in euro scritta in bolletta per quel servizio (di solito accanto al consumo annuo), se presente.
- "kwhFatturati"/"smcFatturati" possono essere 0 se nel periodo non c'è stato consumo: in quel caso scrivi 0, non null.
- "potenzaKw": la potenza impegnata (o disponibile, se manca l'impegnata) del contatore luce, in kW.
- Se la bolletta è solo gas, "luce" = null; se è solo luce, "gas" = null.
- Numeri con il punto decimale (es. 91.46), senza simbolo dell'euro. Se un dato non c'è, null.
- "affidabile" = false se il PDF è una scansione/immagine illeggibile o mancano i dati chiave dello scontrino; in "note" spiega il problema in una frase.
Rispondi solo con il JSON.`;

async function chiamaGemini(modello, pdfBase64, apiKey, ms) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modello}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(ms),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA, thinkingConfig: { thinkingBudget: 1024 } }
    })
  });
  if (!res.ok) throw new Error('Gemini ' + res.status);
  const data = await res.json();
  const testo = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  return JSON.parse(testo);
}

// --- normalizzazione: solo numeri plausibili, mesi nel formato AAAA-MM ---
const num = (v, max) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
};
const mesi = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
  .map(m => String(m).trim()).filter(m => /^20\d\d-(0[1-9]|1[0-2])$/.test(m)))].sort();
const testo = (v, max = 120) => (v == null ? null : String(v).trim().slice(0, max) || null);

// Spesa per la vendita di una voce dello scontrino, con controllo di coerenza:
// vendita + rete deve fare il totale. Se la vendita manca o coincide col totale
// (errore tipico: preso il totale in grassetto) la si ricava come totale - rete.
function vendita(o, voce, max) {
  const tot = num(o[voce + 'Totale'], max), ven = num(o[voce + 'Vendita'], max), rete = num(o[voce + 'Rete'], max);
  const r2 = x => Math.round(x * 100) / 100;
  if (ven != null && rete != null && tot != null) {
    if (Math.abs(ven + rete - tot) <= 0.02) return ven;           // le tre cifre tornano
    if (rete > 0 && Math.abs(ven - tot) <= 0.02) return r2(tot - rete);   // ha ripetuto il totale come vendita
    return ven;
  }
  if (ven != null) return (rete > 0 && tot != null && Math.abs(ven - tot) <= 0.02) ? r2(tot - rete) : ven;
  if (tot != null && rete != null) return r2(tot - rete);
  return null;                                                    // non ricavabile: lo compila l'operatore
}

function normalizza(d) {
  const presente = o => o && Object.values(o).some(v => v !== null && v !== undefined && !(Array.isArray(v) && !v.length));
  const luce = presente(d.luce) ? {
    mesi: mesi(d.luce.mesi),
    kwh: num(d.luce.kwhFatturati, 5e6),
    quotaConsumi: vendita(d.luce, 'quotaConsumi', 1e6),
    quotaFissa: vendita(d.luce, 'quotaFissa', 1e5),
    totaleBolletta: num(d.luce.totaleBolletta, 1e6),
    consumoAnnuo: num(d.luce.consumoAnnuo, 1e7),
    spesaAnnua: num(d.luce.spesaAnnua, 1e6),
    potenzaKw: num(d.luce.potenzaKw, 1e4)
  } : null;
  const gas = presente(d.gas) ? {
    mesi: mesi(d.gas.mesi),
    smc: num(d.gas.smcFatturati, 5e6),
    quotaConsumi: vendita(d.gas, 'quotaConsumi', 1e6),
    quotaFissa: vendita(d.gas, 'quotaFissa', 1e5),
    totaleBolletta: num(d.gas.totaleBolletta, 1e6),
    consumoAnnuo: num(d.gas.consumoAnnuo, 1e7),
    spesaAnnua: num(d.gas.spesaAnnua, 1e6)
  } : null;
  return {
    tipoCliente: d.tipoCliente === 'business' ? 'business' : 'domestico',
    intestatario: testo(d.intestatario),
    fornitore: testo(d.fornitore, 60),
    offertaLuce: testo(d.nomeOffertaLuce, 80),
    offertaGas: testo(d.nomeOffertaGas, 80),
    luce, gas
  };
}

export async function POST(request) {
  const origine = request.headers.get('origin') || '';
  if (origine && !ORIGINI_OK.some(r => r.test(origine))) return json({ errore: 'Origine non consentita.' }, 403);

  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'n/d';
  if (troppeRichieste(ip)) return json({ tipo: 'limite', errore: 'Troppe bollette caricate in pochi minuti. Riprova tra qualche minuto.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ errore: 'Richiesta non valida.' }, 400); }
  const pdf = String(body?.pdf || '');
  if (!pdf) return json({ errore: 'Nessun file ricevuto.' }, 400);
  if (pdf.length * 0.75 > MAX_PDF_BYTES) return json({ tipo: 'grande', errore: 'Il PDF supera i 3 MB: carica il PDF originale del fornitore, non una scansione.' }, 413);
  // un PDF vero inizia con "%PDF" (in base64 "JVBERi")
  if (!pdf.startsWith('JVBERi')) return json({ tipo: 'no-pdf', errore: 'Il file non è un PDF. Carica il PDF originale scaricato dal sito o dall\'app del fornitore.' }, 415);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json({ tipo: 'config', errore: 'La lettura automatica non è ancora attiva su questo sito.' }, 503);

  let ultimoStato = 0, risposto = false, dati = null;
  for (const [modello, ms] of MODELLI) {
    try {
      const out = await chiamaGemini(modello, pdf, apiKey, ms);
      risposto = true;
      if (out && (out.luce || out.gas || out.affidabile === false)) { dati = out; break; }
    } catch (e) {
      const m = /Gemini (\d+)/.exec(e?.message || '');
      ultimoStato = m ? parseInt(m[1], 10) : 503;   // timeout = servizio lento: si prova il modello successivo
    }
  }

  const AVVISO = ' Serve il PDF originale scaricato dal sito o dall\'app del fornitore: una foto o una scansione salvata in PDF non contiene il testo.';
  if (!dati) {
    if (!risposto && (ultimoStato === 429 || ultimoStato >= 500)) {
      return json({ tipo: 'occupato', errore: 'Il servizio di lettura è momentaneamente molto richiesto. Non è un problema del file: riprova tra qualche minuto.' }, 503);
    }
    return json({ tipo: 'illeggibile', errore: 'Non sono riuscito a leggere i dati della bolletta.' + AVVISO }, 422);
  }
  if (dati.affidabile === false) {
    return json({ tipo: 'illeggibile', errore: (dati.note ? dati.note.trim().replace(/([^.!?])$/, '$1.') : 'La bolletta non è abbastanza leggibile.') + AVVISO }, 422);
  }
  const bolletta = normalizza(dati);
  if (!bolletta.luce && !bolletta.gas) {
    return json({ tipo: 'illeggibile', errore: 'Nella bolletta non ho trovato lo Scontrino dell\'energia con i consumi.' + AVVISO }, 422);
  }
  // consumo zero (es. casa vuota): non c'è niente da confrontare, lo diciamo chiaramente
  const consumo = (bolletta.luce?.kwh || 0) + (bolletta.gas?.smc || 0);
  if (!consumo) {
    const cosa = bolletta.luce && bolletta.gas ? 'luce e gas' : (bolletta.luce ? 'luce' : 'gas');
    return json({ tipo: 'zero', errore: `Nel periodo di questa bolletta il consumo ${cosa} fatturato è 0, quindi non c'è una spesa per l'energia da confrontare. Carica una bolletta con consumi.` }, 422);
  }
  return json({ tipo: 'ok', bolletta });
}

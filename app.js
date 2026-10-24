/* =====================================================================
   SITE DOS CLIENTES (vitrine de imóveis)
   Links:
     ?i=<link-da-imobiliaria>  -> pedidos vão para o WhatsApp da imobiliária
     ?c=<link-do-corretor>     -> pedidos vão para o WhatsApp do corretor
     &m=<id-do-imovel>         -> abre direto um imóvel (link compartilhado)
   ===================================================================== */
const C = window.CONFIG;
const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: false } });
const PARAMS = new URLSearchParams(location.search);

const ABAS = [
  { id: "temporada", nome: "Temporada", tem: (m) => m.temporada },
  { id: "alugar", nome: "Alugar", tem: (m) => m.mensal || m.anual },
  { id: "comprar", nome: "Comprar", tem: (m) => m.venda || m.prevenda },
];
const FILTRO_VAZIO = { entrada: "", saida: "", pessoas: 0, quartos: 0, bairro: "", tipo: "", ordem: "padrao" };

const E = {
  imob: null,
  corretor: null,      // { nome, whatsapp } quando o link é de um corretor
  imoveis: [],
  ocupadas: new Map(), // imovel_id -> Set de datas "AAAA-MM-DD"
  aba: null,
  filtro: { ...FILTRO_VAZIO },
  det: null,           // estado da tela de detalhe
};

/* ---------------- utilidades ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const moeda = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: Number(v) % 1 ? 2 : 0 });
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const deYmd = (s) => { const [a, m, d] = s.split("-").map(Number); return new Date(a, m - 1, d); };
const hoje = () => ymd(new Date());
const somaDias = (s, n) => { const d = deYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const noites = (a, b) => Math.round((deYmd(b) - deYmd(a)) / 86400000);
const dataCurta = (s) => deYmd(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const dataLonga = (s) => {
  const d = deYmd(s);
  return `${d.toLocaleDateString("pt-BR")} (${d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "")})`;
};
const plural = (n, s, p) => `${n} ${n == 1 ? s : p}`;

function ytId(url) {
  if (!url) return null;
  const m = String(url).match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

let avisoT;
function aviso(msg) {
  const el = $("#aviso");
  el.textContent = msg; el.classList.remove("hidden");
  clearTimeout(avisoT); avisoT = setTimeout(() => el.classList.add("hidden"), 2600);
}

function travar(on) { document.body.classList.toggle("travado", on); }

/* ---------------- WhatsApp ---------------- */
function numeroDestino() {
  return (E.corretor?.whatsapp || E.imob?.whatsapp || "").replace(/\D/g, "");
}
function linkWpp(texto) {
  const n = numeroDestino();
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(texto)}` : null;
}
// No celular abre na mesma aba: assim o Android/iPhone passa direto para o app
// (WhatsApp ou WhatsApp Business) em vez de mostrar a página "Abrir app".
// No computador abre em outra aba (WhatsApp Web).
function abrirWhatsApp(url) {
  if (!url) return;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) location.href = url;
  else window.open(url, "_blank", "noopener");
}
function linkImovel(m) {
  const u = new URL(location.href);
  u.search = "";
  if (PARAMS.get("c")) u.searchParams.set("c", PARAMS.get("c"));
  else u.searchParams.set("i", E.imob.slug);
  u.searchParams.set("m", m.id);
  return u.toString();
}

/* =====================================================================
   INÍCIO
   ===================================================================== */
async function iniciar() {
  try {
    let slugImob = PARAMS.get("i");
    const slugCorretor = PARAMS.get("c");

    if (slugCorretor) {
      const { data } = await sb.rpc("loc_corretor_publico", { p_slug: slugCorretor });
      const c = data?.[0];
      if (c) { E.corretor = { nome: c.nome, whatsapp: c.whatsapp, foto: c.foto_url }; slugImob = c.imobiliaria_slug; }
    }
    if (!slugImob) return erro();

    const { data: imob } = await sb.from("loc_imobiliarias").select("*").eq("slug", slugImob).eq("ativo", true).maybeSingle();
    if (!imob) return erro();
    E.imob = imob;
    E.fav = lerFavoritos();
    if (E.corretor) E.pessoa = { nome: E.corretor.nome, foto: E.corretor.foto, papel: "Seu corretor" };
    else {
      const { data: resp } = await sb.rpc("loc_responsavel_publico", { p_imob_slug: imob.slug });
      if (resp?.[0]) E.pessoa = { nome: resp[0].nome, foto: resp[0].foto_url, papel: "Corretor responsável" };
    }
    aplicarMarca();

    const [{ data: imoveis, error }, ocupadas] = await Promise.all([
      sb.from("loc_imoveis")
        .select("*, loc_fotos(url, ordem)")
        .eq("imobiliaria_id", imob.id).eq("ativo", true)
        .order("ordem").order("created_at"),
      carregarOcupadas(imob.id),
    ]);
    if (error) throw error;
    E.imoveis = (imoveis || []).map((m) => ({
      ...m, fotos: (m.loc_fotos || []).sort((a, b) => a.ordem - b.ordem).map((f) => f.url),
    }));
    E.ocupadas = ocupadas;

    const abaUrl = PARAMS.get("t");
    E.aba = ABAS.find((a) => a.id === abaUrl && contar(a) > 0)?.id || ABAS.find((a) => contar(a) > 0)?.id || "temporada";

    $("#tela-carregando").classList.add("hidden");
    $("#app").classList.remove("hidden");
    renderAbas();
    renderVitrine();
    renderExtras();

    const mId = PARAMS.get("m");
    if (mId) { const m = E.imoveis.find((x) => x.id === mId); if (m) abrirDetalhe(m, true); }
  } catch (e) {
    console.error(e);
    erro();
  }
}

function erro() {
  $("#tela-carregando").classList.add("hidden");
  $("#tela-erro").classList.remove("hidden");
}

// Datas ocupadas daqui pra frente (em páginas de 1000, para imobiliárias grandes)
async function carregarOcupadas(imobId) {
  const mapa = new Map();
  const passo = 1000;
  for (let ini = 0; ; ini += passo) {
    const { data, error } = await sb.from("loc_datas_ocupadas")
      .select("imovel_id, data").eq("imobiliaria_id", imobId).gte("data", hoje())
      .order("data").range(ini, ini + passo - 1);
    if (error) throw error;
    for (const r of data || []) {
      if (!mapa.has(r.imovel_id)) mapa.set(r.imovel_id, new Set());
      mapa.get(r.imovel_id).add(r.data);
    }
    if (!data || data.length < passo) break;
  }
  return mapa;
}

/* ---------------- marca da imobiliária ---------------- */
const FONTES = {
  moderna: "Inter, system-ui, sans-serif",
  classica: "Georgia, 'Times New Roman', serif",
  elegante: "'Playfair Display', Georgia, serif",
};

function aplicarMarca() {
  const im = E.imob;
  const r = document.documentElement.style;
  r.setProperty("--cor", im.cor_principal || "#0d2c4a");
  r.setProperty("--dest", im.cor_destaque || "#d99a3a");
  r.setProperty("--fonte-titulo", FONTES[im.fonte] || FONTES.moderna);
  document.body.dataset.modelo = ["classico", "moderno", "luxo"].includes(im.modelo) ? im.modelo : "classico";
  $('meta[name="theme-color"]').setAttribute("content", im.modelo === "luxo" ? "#0e0f11" : im.modelo === "moderno" ? "#ffffff" : im.cor_principal);
  document.title = im.nome;

  $("#topo-logo").innerHTML = im.logo_url ? `<img src="${esc(im.logo_url)}" alt="">` : "🏠";
  if (im.logo_url) {
    // favicon com a logo da imobiliária
    const l = document.createElement("link"); l.rel = "icon"; l.href = im.logo_url; document.head.appendChild(l);
  }
  $("#topo-nome").textContent = im.nome;

  const hero = $("#hero");
  const capaPc = im.capa_url, capaCel = im.capa_mobile_url || im.capa_url;
  if (im.capa_modo === "banner" && capaPc) {
    // Banner pronto (já tem logo/nome na arte): imagem inteira, sem texto por cima.
    // No celular usa a "capa para celular" quando existir.
    hero.classList.add("hero-banner");
    hero.innerHTML = `<picture>
      ${im.capa_mobile_url ? `<source media="(max-width: 700px)" srcset="${esc(im.capa_mobile_url)}">` : ""}
      <img src="${esc(capaPc)}" alt="${esc(im.nome)}">
    </picture>`;
    if (im.capa_mobile_url) hero.classList.add("tem-celular");
    if (E.corretor) {
      hero.insertAdjacentHTML("afterend", `<div class="faixa-corretor">👤 Atendimento: <b>${esc(E.corretor.nome)}</b></div>`);
    }
  } else {
    if (capaPc) {
      const mq = matchMedia("(max-width: 700px)");
      const usar = () => { hero.style.backgroundImage = `url('${mq.matches ? capaCel : capaPc}')`; };
      usar(); mq.addEventListener?.("change", usar);
    }
    $("#hero-titulo").textContent = im.slogan || im.nome;
    $("#hero-sub").textContent = im.slogan ? im.nome : "Encontre o imóvel ideal para você";
    if (E.corretor) {
      const hc = $("#hero-corretor");
      hc.textContent = `👤 Atendimento: ${E.corretor.nome}`;
      hc.classList.remove("hidden");
    }
  }

  const wpp = linkWpp(`Olá! Vim pelo site da ${im.nome} e gostaria de mais informações.`);
  if (wpp) { const a = $("#topo-wpp"); a.href = wpp; a.dataset.wpp = ""; a.classList.remove("hidden"); }

  $("#rodape").innerHTML = `
    ${redesHtml(im)}
    <b>${esc(im.nome)}</b>
    ${im.creci ? `<div>${esc(im.creci)}</div>` : ""}
    ${E.corretor ? `<div>Atendimento: ${esc(E.corretor.nome)}</div>` : ""}`;
  renderPessoaHero();
}

/* ---------------- corretor na capa (foto "subindo") ---------------- */
async function renderPessoaHero() {
  const p = E.pessoa;
  if (!p?.foto) return;   // sem foto: fica só o selo "Atendimento: Fulano"
  const recortada = await fotoSemFundo(p.foto);
  const hero = $("#hero");
  hero.classList.add("com-pessoa");
  $("#hero-corretor")?.classList.add("hidden");
  document.querySelector(".faixa-corretor")?.remove();
  hero.insertAdjacentHTML("beforeend", `
    <button class="hero-pessoa ${recortada ? "" : "em-circulo"}" id="hero-pessoa" aria-label="Falar com ${esc(p.nome)} no WhatsApp">
      <img src="${esc(p.foto)}" alt="${esc(p.nome)}">
      <span class="hero-pessoa-nome"><b>${esc(p.nome)}</b><small>${esc(p.papel)}</small></span>
    </button>`);
  $("#hero-pessoa").onclick = () => {
    const url = linkWpp(`Olá, ${p.nome.split(" ")[0]}! Vim pelo site da ${E.imob.nome} e gostaria de ajuda para encontrar um imóvel.`);
    abrirWhatsApp(url);
  };
}

// Descobre se a foto está recortada (fundo transparente) olhando a transparência das bordas.
// Foto com fundo (ou se não der para analisar) -> mostra em círculo.
function fotoSemFundo(url) {
  return new Promise((ok) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const fim = setTimeout(() => ok(false), 2500);
    img.onerror = () => { clearTimeout(fim); ok(false); };
    img.onload = () => {
      clearTimeout(fim);
      try {
        const w = 60, h = Math.max(1, Math.round(60 * img.naturalHeight / img.naturalWidth));
        const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;
        const alfa = (x, y) => px[(y * w + x) * 4 + 3];
        // cantos de cima e laterais: numa foto recortada são transparentes
        const pontos = [[0, 0], [w - 1, 0], [0, Math.floor(h / 3)], [w - 1, Math.floor(h / 3)], [Math.floor(w / 2), 0]];
        const transparentes = pontos.filter(([x, y]) => alfa(x, y) < 20).length;
        ok(transparentes >= 3);
      } catch (_) { ok(false); }
    };
    img.src = url;
  });
}

/* ---------------- redes sociais ---------------- */
function linkRede(tipo, v) {
  if (!v) return null;
  v = String(v).trim();
  if (/^https?:\/\//i.test(v)) return v;
  const u = v.replace(/^@/, "");
  return {
    instagram: `https://instagram.com/${u}`,
    facebook: `https://facebook.com/${u}`,
    youtube: `https://youtube.com/@${u}`,
    tiktok: `https://www.tiktok.com/@${u}`,
  }[tipo];
}
const ICONES = {
  instagram: '<path fill="currentColor" d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4ZM17.3 5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM12 2c-2.7 0-3 0-4.1.1C4.3 2.2 2.2 4.3 2.1 7.9 2 9 2 9.3 2 12s0 3 .1 4.1c.1 3.6 2.2 5.7 5.8 5.8 1.1.1 1.4.1 4.1.1s3 0 4.1-.1c3.6-.1 5.7-2.2 5.8-5.8.1-1.1.1-1.4.1-4.1s0-3-.1-4.1c-.1-3.6-2.2-5.7-5.8-5.8C15 2 14.7 2 12 2Zm0 1.8c2.7 0 3 0 4 .1 2.6.1 3.9 1.4 4 4 .1 1 .1 1.3.1 4s0 3-.1 4c-.1 2.6-1.4 3.9-4 4-1 .1-1.3.1-4 .1s-3 0-4-.1c-2.6-.1-3.9-1.4-4-4-.1-1-.1-1.3-.1-4s0-3 .1-4c.1-2.6 1.4-3.9 4-4 1-.1 1.3-.1 4-.1Z"/>',
  facebook: '<path fill="currentColor" d="M14 8V6.2c0-.8.2-1.2 1.4-1.2H17V2h-2.7C11.4 2 10.5 3.4 10.5 5.9V8H8v3h2.5v11H14V11h2.6l.4-3Z"/>',
  youtube: '<path fill="currentColor" d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12 31 31 0 0 0 1 16.8a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8ZM9.7 15V9l5.8 3-5.8 3Z"/>',
  tiktok: '<path fill="currentColor" d="M16.6 2h-3.4v13.4a2.9 2.9 0 1 1-2.1-2.8V9.1a6.3 6.3 0 1 0 5.5 6.3V8.6a8 8 0 0 0 4.4 1.3V6.5a4.4 4.4 0 0 1-4.4-4.5Z"/>',
};
function redesHtml(im) {
  const itens = ["instagram", "facebook", "youtube", "tiktok"].map((t) => [t, linkRede(t, im[t])]).filter(([, u]) => u);
  if (!itens.length) return "";
  return `<div class="redes">${itens.map(([t, u]) =>
    `<a href="${esc(u)}" target="_blank" rel="noopener" aria-label="${t}"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${ICONES[t]}</svg></a>`).join("")}</div>`;
}

/* ---------------- WhatsApp flutuante + "Anuncie seu imóvel" ---------------- */
function renderExtras() {
  const n = numeroDestino();
  if (n) {
    document.body.insertAdjacentHTML("beforeend", `
      <a class="wpp-flutuante" id="wpp-flutuante" data-wpp target="_blank" rel="noopener" aria-label="Falar no WhatsApp"
         href="${esc(linkWpp(`Olá! Vim pelo site da ${E.imob.nome} e gostaria de mais informações.`))}">
        <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3a.4.4 0 0 0 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.4-.3Z"/></svg>
      </a>`);
    $("main.vitrine").insertAdjacentHTML("beforeend", `
      <section class="anuncie">
        <div>
          <h2>É proprietário?</h2>
          <p>Anuncie seu imóvel com a ${esc(E.imob.nome)}. Cuidamos da divulgação e do atendimento aos interessados.</p>
        </div>
        <a class="btn btn-destaque" data-wpp target="_blank" rel="noopener"
           href="${esc(linkWpp(`Olá! Sou proprietário e gostaria de anunciar meu imóvel com a ${E.imob.nome}.`))}">Quero anunciar meu imóvel</a>
      </section>`);
  }
  renderBarraFav();
}

/* ---------------- favoritos ---------------- */
const chaveFav = () => `fav_${E.imob.id}`;
function lerFavoritos() {
  try { return new Set(JSON.parse(localStorage.getItem(`fav_${E.imob?.id}`) || "[]")); } catch (_) { return new Set(); }
}
function salvarFavoritos() {
  try { localStorage.setItem(chaveFav(), JSON.stringify([...E.fav])); } catch (_) {}
}
const CORACAO = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.4h2c.7-1.2 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21Z"/></svg>';
function btnFav(m) {
  const on = E.fav.has(m.id);
  return `<button class="btn-fav ${on ? "on" : ""}" data-fav="${m.id}" aria-label="${on ? "Tirar dos favoritos" : "Salvar nos favoritos"}">${CORACAO}</button>`;
}
function alternarFav(id) {
  if (E.fav.has(id)) E.fav.delete(id); else { E.fav.add(id); aviso("❤️ Salvo nos seus favoritos"); }
  salvarFavoritos();
  document.querySelectorAll(`[data-fav="${id}"]`).forEach((b) => b.classList.toggle("on", E.fav.has(id)));
  renderBarraFav();
}
function atualizarFavDetalhe() {
  const b = $("#detalhe-fav"); if (!b || !E.det) return;
  b.dataset.fav = E.det.m.id;
  b.classList.toggle("on", E.fav.has(E.det.m.id));
}
function favoritosValidos() { return E.imoveis.filter((m) => E.fav.has(m.id)); }
function renderBarraFav() {
  let bar = $("#barra-fav");
  const lista = favoritosValidos();
  if (!lista.length) { bar?.remove(); return; }
  if (!bar) {
    document.body.insertAdjacentHTML("beforeend", `<button class="barra-fav" id="barra-fav"></button>`);
    bar = $("#barra-fav");
    bar.onclick = abrirFavoritos;
  }
  bar.innerHTML = `${CORACAO}<span>${plural(lista.length, "favorito", "favoritos")}</span>`;
}
function abrirFavoritos() {
  const lista = favoritosValidos();
  const folha = document.createElement("div");
  folha.className = "folha-fundo"; folha.id = "folha-fav";
  folha.innerHTML = `<div class="folha">
    <div class="folha-topo"><h2>Meus favoritos</h2><button class="btn-x" data-fechar aria-label="Fechar">✕</button></div>
    <div class="folha-corpo">
      ${lista.map((m) => `<div class="fav-item" data-abrir="${m.id}">
        <div class="fav-foto" style="${m.fotos[0] ? `background-image:url('${esc(m.fotos[0])}')` : ""}"></div>
        <div class="fav-info"><b>${esc(m.titulo)}</b><span>${esc([m.codigo ? "Cód. " + m.codigo : "", m.bairro].filter(Boolean).join(" · "))}</span></div>
        <button class="btn-x" data-tirar-fav="${m.id}" aria-label="Remover">✕</button>
      </div>`).join("")}
      <p style="color:var(--muted);font-size:13px;margin:14px 0 0">Seus favoritos ficam salvos neste aparelho.</p>
    </div>
    <div class="folha-rodape">
      ${numeroDestino() ? `<button class="btn btn-wpp" id="enviar-favs" style="flex:1">💬 Enviar favoritos no WhatsApp</button>` : ""}
    </div>
  </div>`;
  document.body.appendChild(folha); travar(true);
  const fechar = () => { folha.remove(); travar(!!E.det); };
  folha.onclick = (ev) => {
    if (ev.target === folha || ev.target.closest("[data-fechar]")) return fechar();
    const t = ev.target.closest("[data-tirar-fav]");
    if (t) { alternarFav(t.dataset.tirarFav); fechar(); if (favoritosValidos().length) abrirFavoritos(); return; }
    const ab = ev.target.closest("[data-abrir]");
    if (ab) { fechar(); abrirDetalhe(E.imoveis.find((m) => m.id === ab.dataset.abrir)); }
  };
  $("#enviar-favs")?.addEventListener("click", () => {
    const linhas = [`Olá! Vi no site da *${E.imob.nome}* e gostei destes imóveis:`, ""];
    lista.forEach((m, i) => linhas.push(`${i + 1}. *${m.titulo}*${m.codigo ? ` _(Cód. ${m.codigo})_` : ""}`, `- ${linkImovel(m)}`, ""));
    linhas.push("Pode me passar mais informações?");
    abrirWhatsApp(linkWpp(linhas.join("\n")));
  });
}

/* =====================================================================
   ABAS E FILTROS
   ===================================================================== */
function contar(aba) { return E.imoveis.filter(aba.tem).length; }

function renderAbas() {
  const visiveis = ABAS.filter((a) => contar(a) > 0);
  const nav = $("#abas");
  if (visiveis.length <= 1) { nav.classList.add("hidden"); return; }
  nav.innerHTML = visiveis.map((a) =>
    `<button class="aba ${a.id === E.aba ? "ativa" : ""}" data-aba="${a.id}">${a.nome}<span class="n">${contar(a)}</span></button>`).join("");
  nav.onclick = (ev) => {
    const b = ev.target.closest(".aba"); if (!b) return;
    E.aba = b.dataset.aba;
    nav.querySelectorAll(".aba").forEach((x) => x.classList.toggle("ativa", x === b));
    renderVitrine();
  };
}

function livreNoPeriodo(m, entrada, saida) {
  const oc = E.ocupadas.get(m.id);
  if (!oc) return true;
  for (let d = entrada; d < saida; d = somaDias(d, 1)) if (oc.has(d)) return false;
  return true;
}

function precoBase(m) {
  if (E.aba === "temporada") return m.valor_diaria;
  if (E.aba === "alugar") return m.mensal ? m.valor_mensal : m.valor_anual;
  return m.venda ? m.valor_venda : m.valor_prevenda;
}

function filtrar(f = E.filtro) {
  const aba = ABAS.find((a) => a.id === E.aba);
  let lista = E.imoveis.filter(aba.tem);
  const comDatas = E.aba === "temporada" && f.entrada && f.saida && f.saida > f.entrada;
  if (comDatas) lista = lista.filter((m) => livreNoPeriodo(m, f.entrada, f.saida));
  if (f.pessoas) lista = lista.filter((m) => !m.capacidade || m.capacidade >= f.pessoas);
  if (f.quartos) lista = lista.filter((m) => (m.quartos ?? 0) >= f.quartos);
  if (f.bairro) lista = lista.filter((m) => (m.bairro || "") === f.bairro);
  if (f.tipo) lista = lista.filter((m) => (m.tipo || "") === f.tipo);
  if (f.ordem !== "padrao") {
    const v = (m) => precoBase(m) ?? (f.ordem === "menor" ? Infinity : -Infinity);
    lista = [...lista].sort((a, b) => f.ordem === "menor" ? v(a) - v(b) : v(b) - v(a));
  }
  return lista;
}

function filtrosAtivos() {
  const f = E.filtro, out = [];
  if (E.aba === "temporada" && f.entrada && f.saida) out.push(["datas", `${dataCurta(f.entrada)} → ${dataCurta(f.saida)}`]);
  if (f.pessoas) out.push(["pessoas", plural(f.pessoas, "pessoa", "pessoas")]);
  if (f.quartos) out.push(["quartos", `${f.quartos}+ quartos`]);
  if (f.bairro) out.push(["bairro", f.bairro]);
  if (f.tipo) out.push(["tipo", f.tipo]);
  if (f.ordem !== "padrao") out.push(["ordem", f.ordem === "menor" ? "Menor preço" : "Maior preço"]);
  return out;
}

/* =====================================================================
   VITRINE
   ===================================================================== */
function renderVitrine() {
  const lista = filtrar();
  const ativos = filtrosAtivos();
  const badge = $("#filtro-badge");
  badge.textContent = ativos.length; badge.classList.toggle("hidden", !ativos.length);
  $("#chips-ativos").innerHTML = ativos.map(([k, t]) =>
    `<span class="chip-ativo">${esc(t)}<button data-tirar="${k}" aria-label="Remover filtro">✕</button></span>`).join("");
  $("#chips-ativos").onclick = (ev) => {
    const b = ev.target.closest("[data-tirar]"); if (!b) return;
    const k = b.dataset.tirar;
    if (k === "datas") { E.filtro.entrada = ""; E.filtro.saida = ""; }
    else E.filtro[k] = FILTRO_VAZIO[k];
    renderVitrine();
  };

  const f = E.filtro;
  const comDatas = E.aba === "temporada" && f.entrada && f.saida;
  $("#contagem").textContent = comDatas
    ? `${plural(lista.length, "imóvel livre", "imóveis livres")} de ${dataCurta(f.entrada)} a ${dataCurta(f.saida)} (${plural(noites(f.entrada, f.saida), "diária", "diárias")})`
    : plural(lista.length, "imóvel", "imóveis");

  const grade = $("#grade");
  if (!E.imoveis.length) {
    grade.innerHTML = `<div class="vazio">Nenhum imóvel disponível no momento.<br>Fale com a gente pelo WhatsApp!</div>`;
    return;
  }
  if (!lista.length) {
    grade.innerHTML = `<div class="vazio">Nenhum imóvel encontrado com esses filtros.<br><b>Tente mudar as datas ou limpar os filtros.</b></div>`;
    return;
  }
  grade.innerHTML = lista.map((m) => cardHtml(m, comDatas)).join("");
  grade.onclick = (ev) => {
    const fb = ev.target.closest("[data-fav]");
    if (fb) { ev.stopPropagation(); alternarFav(fb.dataset.fav); return; }
    const c = ev.target.closest(".card"); if (!c) return;
    abrirDetalhe(E.imoveis.find((m) => m.id === c.dataset.id));
  };
}

function caracteristicas(m) {
  const c = [];
  if (m.quartos != null) c.push(["🛏", plural(m.quartos, "quarto", "quartos")]);
  if (m.suites) c.push(["🛁", plural(m.suites, "suíte", "suítes")]);
  if (m.banheiros != null) c.push(["🚿", plural(m.banheiros, "banheiro", "banheiros")]);
  if (m.capacidade) c.push(["👥", `até ${m.capacidade}`]);
  if (m.vagas) c.push(["🚗", plural(m.vagas, "vaga", "vagas")]);
  if (m.area_m2) c.push(["📐", `${Number(m.area_m2).toLocaleString("pt-BR")} m²`]);
  return c;
}

function precoCard(m, comDatas) {
  const f = E.filtro;
  if (E.aba === "temporada") {
    if (!m.valor_diaria) return `<span class="valor">Consulte</span><span class="por">valores</span>`;
    const extra = comDatas ? `<span class="extra">Referência para ${plural(noites(f.entrada, f.saida), "diária", "diárias")}: ${moeda(m.valor_diaria * noites(f.entrada, f.saida))}</span>` : "";
    return `<span class="valor">${moeda(m.valor_diaria)}</span><span class="por">/ diária</span>${extra}`;
  }
  if (E.aba === "alugar") {
    const v = m.mensal ? m.valor_mensal : m.valor_anual;
    const tipo = m.mensal && m.anual ? "mensal ou anual" : m.mensal ? "aluguel mensal" : "contrato anual";
    return v ? `<span class="valor">${moeda(v)}</span><span class="por">/ mês</span><span class="extra">${tipo}</span>`
             : `<span class="valor">Consulte</span><span class="por">${tipo}</span>`;
  }
  const v = m.venda ? m.valor_venda : m.valor_prevenda;
  const pre = !m.venda && m.prevenda;
  return v ? `${pre ? `<span class="por">a partir de</span>` : ""}<span class="valor">${moeda(v)}</span>`
           : `<span class="valor">Sob consulta</span>`;
}

function cardHtml(m, comDatas) {
  const foto = m.fotos[0];
  const selos = [];
  if (comDatas) selos.push(`<span class="livre">✓ Livre nas suas datas</span>`);
  if (E.aba === "comprar" && m.prevenda && !m.venda) selos.push(`<span class="lanc">Lançamento</span>`);
  const meus = (m.selos || []).slice(0, 2);
  for (const s of meus) selos.push(`<span class="destaque">${esc(s)}</span>`);
  const dist = (m.distancia_praia || "").trim();
  if (dist && selos.length < 2 && !meus.some((s) => s.toLowerCase() === dist.toLowerCase())) selos.push(`<span>🌊 ${esc(dist)}</span>`);
  const local = [m.tipo, m.bairro].filter(Boolean).join(" · ");
  return `<article class="card" data-id="${m.id}">
    <div class="card-foto">
      ${foto ? `<img src="${esc(foto)}" alt="${esc(m.titulo)}" loading="lazy">` : `<div class="sem-foto">🏠</div>`}
      ${selos.length ? `<div class="card-selo">${selos.join("")}</div>` : ""}
      <div class="card-dir">
        ${m.fotos.length > 1 ? `<span class="card-nfotos">📷 ${m.fotos.length}</span>` : ""}
        ${btnFav(m)}
      </div>
    </div>
    <div class="card-info">
      ${m.codigo ? `<div class="card-cod">Cód. ${esc(m.codigo)}</div>` : ""}
      <h3>${esc(m.titulo)}</h3>
      ${local ? `<div class="card-local">${esc(local)}</div>` : ""}
      <div class="card-carac">${caracteristicas(m).slice(0, 5).map(([i, t]) => `<span>${i} ${esc(t)}</span>`).join("")}</div>
      <div class="card-preco">${precoCard(m, comDatas)}</div>
    </div>
  </article>`;
}

/* =====================================================================
   FOLHA DE FILTROS
   ===================================================================== */
let rascunho = null;

$("#btn-filtro").onclick = abrirFiltros;
function abrirFiltros() {
  rascunho = { ...E.filtro };
  renderFiltros();
  $("#folha-filtro").classList.remove("hidden");
  travar(true);
}
function fecharFiltros() { $("#folha-filtro").classList.add("hidden"); travar(false); }
$("#folha-filtro").onclick = (ev) => {
  if (ev.target.id === "folha-filtro" || ev.target.closest("[data-fechar]")) fecharFiltros();
};
$("#filtro-limpar").onclick = () => { rascunho = { ...FILTRO_VAZIO }; renderFiltros(); };
$("#filtro-aplicar").onclick = () => {
  if (rascunho.entrada && rascunho.saida && rascunho.saida <= rascunho.entrada) { aviso("A saída precisa ser depois da entrada."); return; }
  if ((rascunho.entrada && !rascunho.saida) || (!rascunho.entrada && rascunho.saida)) { aviso("Escolha a data de entrada e a de saída."); return; }
  E.filtro = { ...rascunho };
  fecharFiltros();
  renderVitrine();
  window.scrollTo({ top: $("#abas").offsetTop - 70, behavior: "smooth" });
};

function opcoesUnicas(campo) {
  const aba = ABAS.find((a) => a.id === E.aba);
  return [...new Set(E.imoveis.filter(aba.tem).map((m) => m[campo]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function renderFiltros() {
  const r = rascunho;
  const bairros = opcoesUnicas("bairro"), tipos = opcoesUnicas("tipo");
  $("#filtro-corpo").innerHTML = `
    ${E.aba === "temporada" ? `
    <div class="grupo">
      <h3>Quando você vem?</h3>
      <p class="dica">Mostramos só os imóveis livres no período todo.</p>
      <div class="datas">
        <label class="campo">Entrada<input type="date" id="f-entrada" min="${hoje()}" value="${r.entrada}"></label>
        <label class="campo">Saída<input type="date" id="f-saida" min="${r.entrada ? somaDias(r.entrada, 1) : somaDias(hoje(), 1)}" value="${r.saida}"></label>
      </div>
    </div>` : ""}
    <div class="grupo contador">
      <h3 style="margin:0">Pessoas</h3>
      <div class="ctrl"><button data-p="-1" aria-label="Menos">−</button><b>${r.pessoas || "—"}</b><button data-p="1" aria-label="Mais">+</button></div>
    </div>
    <div class="grupo">
      <h3>Quartos</h3>
      <div class="opcoes" data-grupo="quartos">
        ${[0, 1, 2, 3, 4].map((q) => `<button class="opcao ${r.quartos === q ? "on" : ""}" data-v="${q}">${q ? q + "+" : "Qualquer"}</button>`).join("")}
      </div>
    </div>
    ${bairros.length > 1 ? `<div class="grupo"><label class="campo">Bairro<select id="f-bairro"><option value="">Todos</option>
      ${bairros.map((b) => `<option ${r.bairro === b ? "selected" : ""}>${esc(b)}</option>`).join("")}</select></label></div>` : ""}
    ${tipos.length > 1 ? `<div class="grupo"><label class="campo">Tipo de imóvel<select id="f-tipo"><option value="">Todos</option>
      ${tipos.map((t) => `<option ${r.tipo === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label></div>` : ""}
    <div class="grupo">
      <h3>Ordenar por</h3>
      <div class="opcoes" data-grupo="ordem">
        ${[["padrao", "Destaques"], ["menor", "Menor preço"], ["maior", "Maior preço"]].map(([v, t]) =>
          `<button class="opcao ${r.ordem === v ? "on" : ""}" data-v="${v}">${t}</button>`).join("")}
      </div>
    </div>
  `;
  atualizarBotaoAplicar();

  const corpo = $("#filtro-corpo");
  corpo.onclick = (ev) => {
    const p = ev.target.closest("[data-p]");
    if (p) { r.pessoas = Math.max(0, Math.min(30, (r.pessoas || 0) + Number(p.dataset.p))); renderFiltros(); return; }
    const o = ev.target.closest(".opcao");
    if (o) {
      const g = o.parentElement.dataset.grupo;
      r[g] = g === "quartos" ? Number(o.dataset.v) : o.dataset.v;
      renderFiltros();
    }
  };
  $("#f-entrada")?.addEventListener("change", (ev) => {
    r.entrada = ev.target.value;
    if (r.saida && r.saida <= r.entrada) r.saida = "";
    renderFiltros();
    if (r.entrada && !r.saida) { try { $("#f-saida")?.showPicker?.(); } catch (_) {} }
  });
  $("#f-saida")?.addEventListener("change", (ev) => { r.saida = ev.target.value; renderFiltros(); });
  $("#f-bairro")?.addEventListener("change", (ev) => { r.bairro = ev.target.value; atualizarBotaoAplicar(); });
  $("#f-tipo")?.addEventListener("change", (ev) => { r.tipo = ev.target.value; atualizarBotaoAplicar(); });
}

function atualizarBotaoAplicar() {
  const r = rascunho;
  const valido = !(r.entrada || r.saida) || (r.entrada && r.saida && r.saida > r.entrada);
  const n = filtrar(valido ? r : { ...r, entrada: "", saida: "" }).length;
  $("#filtro-aplicar").textContent = n ? `Ver ${plural(n, "imóvel", "imóveis")}` : "Nenhum imóvel";
}

/* =====================================================================
   DETALHE DO IMÓVEL
   ===================================================================== */
function abrirDetalhe(m, viaLink = false) {
  const f = E.filtro;
  E.det = {
    m,
    mes: null,
    ini: E.aba === "temporada" && f.entrada && livreNoPeriodo(m, f.entrada, f.saida) ? f.entrada : null,
    fim: E.aba === "temporada" && f.saida && livreNoPeriodo(m, f.entrada, f.saida) ? f.saida : null,
    pessoas: f.pessoas || "",
    nome: "",
    modo: modoDoImovel(m),
  };
  const base = E.det.ini ? deYmd(E.det.ini) : new Date();
  E.det.mes = new Date(base.getFullYear(), base.getMonth(), 1);

  renderDetalhe();
  atualizarFavDetalhe();
  $("#detalhe").classList.remove("hidden");
  $("#detalhe-scroll").scrollTop = 0;
  travar(true);
  if (!viaLink) history.pushState({ det: m.id }, "", linkImovel(m));
  else history.replaceState({ det: m.id, direto: true }, "", location.href);
}

function modoDoImovel(m) {
  // Se o imóvel tem a modalidade da aba atual, usa ela; senão, a primeira que ele tiver
  const atual = ABAS.find((a) => a.id === E.aba);
  if (atual && atual.tem(m)) return atual.id;
  return ABAS.find((a) => a.tem(m))?.id || "temporada";
}

function fecharDetalhe() {
  $("#detalhe").classList.add("hidden");
  travar(false);
  E.det = null;
}
$("#detalhe-voltar").onclick = () => {
  if (history.state?.det && !history.state.direto) history.back();
  else { fecharDetalhe(); history.replaceState(null, "", urlSemImovel()); }
};
window.addEventListener("popstate", () => {
  if (!$("#foto-cheia").classList.contains("hidden")) { $("#foto-cheia").classList.add("hidden"); }
  if (E.det) fecharDetalhe();
});
function urlSemImovel() { const u = new URL(location.href); u.searchParams.delete("m"); return u.toString(); }

$("#detalhe-fav").onclick = () => { if (E.det) { alternarFav(E.det.m.id); atualizarFavDetalhe(); } };
$("#detalhe-compartilhar").onclick = async () => {
  const m = E.det?.m; if (!m) return;
  const url = linkImovel(m);
  try {
    if (navigator.share) await navigator.share({ title: m.titulo, text: `${m.titulo} - ${E.imob.nome}`, url });
    else { await navigator.clipboard.writeText(url); aviso("Link copiado!"); }
  } catch (_) {}
};

function renderDetalhe() {
  const { m, modo } = E.det;
  const local = [m.tipo, m.bairro, m.endereco].filter(Boolean).join(" · ");
  const carac = [
    ["quartos", "Quartos"], ["suites", "Suítes"], ["banheiros", "Banheiros"],
    ["vagas", "Vagas"], ["capacidade", "Pessoas"], ["area_m2", "m²"],
  ].filter(([k]) => m[k] != null && m[k] !== "");
  const vid = ytId(m.video_url);

  $("#detalhe-scroll").innerHTML = `
    <div class="det-max">
      ${galeriaHtml(m)}
      <div class="det-corpo">
        ${m.codigo ? `<div class="card-cod">Cód. ${esc(m.codigo)}</div>` : ""}
        <h1>${esc(m.titulo)}</h1>
        ${m.selos?.length ? `<div class="det-selos">${m.selos.map((s) => `<span>${esc(s)}</span>`).join("")}</div>` : ""}
        ${local ? `<div class="det-local">${esc(local)}${m.distancia_praia ? ` · 🌊 ${esc(m.distancia_praia)}` : ""}</div>` : ""}

        <div class="det-precos">${precosDetalhe(m)}</div>

        ${carac.length ? `<div class="det-carac">${carac.map(([k, t]) =>
          `<div><b>${k === "area_m2" ? Number(m[k]).toLocaleString("pt-BR") : esc(m[k])}</b><span>${t}</span></div>`).join("")}</div>` : ""}

        ${m.descricao ? `<div class="secao"><h2>Sobre o imóvel</h2><p class="desc">${esc(m.descricao)}</p></div>` : ""}

        ${m.comodidades?.length ? `<div class="secao"><h2>Comodidades</h2><div class="comod">${m.comodidades.map((c) => `<span>${esc(c)}</span>`).join("")}</div></div>` : ""}

        ${vid ? `<div class="secao"><h2>Vídeo</h2><div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${vid}?rel=0" title="Vídeo do imóvel" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div></div>` : ""}

        ${modo === "temporada" ? `<div class="secao" id="secao-datas"><h2>Disponibilidade</h2><p class="desc" style="color:var(--muted);font-size:14px;margin-bottom:10px">Toque no dia de entrada e depois no dia de saída.</p><div id="cal"></div><div id="resumo"></div>
          <div class="form-orc">
            <label class="campo">Quantas pessoas?<input type="number" id="orc-pessoas" min="1" inputmode="numeric" value="${E.det.pessoas}"></label>
            <label class="campo">Seu nome<input id="orc-nome" autocomplete="name" placeholder="Opcional" value="${esc(E.det.nome)}"></label>
          </div>
        </div>` : ""}

        ${modo !== "temporada" && m.disponivel_a_partir && modo === "alugar" ? `<div class="secao"><h2>Disponibilidade</h2><p class="desc">Disponível a partir de <b>${deYmd(m.disponivel_a_partir).toLocaleDateString("pt-BR")}</b></p></div>` : ""}
      </div>
    </div>
  `;
  ligarGaleria(m);
  if (modo === "temporada") {
    renderCalendario();
    $("#orc-pessoas").oninput = (ev) => { E.det.pessoas = ev.target.value; };
    $("#orc-nome").oninput = (ev) => { E.det.nome = ev.target.value; };
  }
  renderAcao();
}

function precosDetalhe(m) {
  const linhas = [];
  if (m.temporada) linhas.push(["Diária", m.valor_diaria ? moeda(m.valor_diaria) : "Consulte"]);
  if (m.mensal) linhas.push(["Aluguel mensal", m.valor_mensal ? `${moeda(m.valor_mensal)} / mês` : "Consulte"]);
  if (m.anual) linhas.push(["Contrato anual", m.valor_anual ? `${moeda(m.valor_anual)} / mês` : "Consulte"]);
  if (m.venda) linhas.push(["Venda", m.valor_venda ? moeda(m.valor_venda) : "Sob consulta"]);
  if (m.prevenda) linhas.push(["Lançamento", m.valor_prevenda ? `a partir de ${moeda(m.valor_prevenda)}` : "Sob consulta"]);
  return linhas.map(([r, v]) => `<div class="det-preco"><span class="rot">${r}</span><span class="val">${v}</span></div>`).join("");
}

/* ---------- galeria ---------- */
function galeriaHtml(m) {
  if (!m.fotos.length) return `<div class="galeria-vazia">🏠</div>`;
  return `<div class="galeria">
    <div class="galeria-trilho" id="galeria-trilho">
      ${m.fotos.map((u, i) => `<img src="${esc(u)}" alt="Foto ${i + 1}" ${i > 1 ? 'loading="lazy"' : ""} data-i="${i}">`).join("")}
    </div>
    ${m.fotos.length > 1 ? `
      <button class="btn-redondo galeria-seta esq" data-mover="-1" aria-label="Foto anterior">‹</button>
      <button class="btn-redondo galeria-seta dir" data-mover="1" aria-label="Próxima foto">›</button>
      <span class="galeria-cont" id="galeria-cont">1 / ${m.fotos.length}</span>` : ""}
  </div>`;
}

function ligarGaleria(m) {
  const tr = $("#galeria-trilho"); if (!tr) return;
  const atual = () => Math.round(tr.scrollLeft / tr.clientWidth);
  tr.onscroll = () => { const c = $("#galeria-cont"); if (c) c.textContent = `${atual() + 1} / ${m.fotos.length}`; };
  document.querySelectorAll("[data-mover]").forEach((b) => b.onclick = () => {
    tr.scrollTo({ left: (atual() + Number(b.dataset.mover)) * tr.clientWidth, behavior: "smooth" });
  });
  tr.onclick = (ev) => { const img = ev.target.closest("img"); if (img) abrirFotoCheia(m, Number(img.dataset.i)); };
}

function abrirFotoCheia(m, i) {
  const tr = $("#foto-cheia-trilho");
  tr.innerHTML = m.fotos.map((u) => `<img src="${esc(u)}" alt="">`).join("");
  $("#foto-cheia").classList.remove("hidden");
  requestAnimationFrame(() => { tr.scrollLeft = i * tr.clientWidth; });
}
$("#foto-cheia-fechar").onclick = () => $("#foto-cheia").classList.add("hidden");

/* ---------- calendário de disponibilidade ---------- */
function renderCalendario() {
  const d = E.det, m = d.m;
  const oc = E.ocupadas.get(m.id) || new Set();
  const ano = d.mes.getFullYear(), mes = d.mes.getMonth();
  const h = hoje();
  const mesAtual = new Date(); mesAtual.setDate(1);
  const podeVoltar = d.mes > new Date(mesAtual.getFullYear(), mesAtual.getMonth(), 1);
  const limite = new Date(); limite.setMonth(limite.getMonth() + 18);
  const podeAvancar = d.mes < limite;

  let dias = "";
  const primeiro = new Date(ano, mes, 1).getDay();
  for (let i = 0; i < primeiro; i++) dias += `<span class="dia vazio"></span>`;
  const total = new Date(ano, mes + 1, 0).getDate();
  for (let n = 1; n <= total; n++) {
    const s = ymd(new Date(ano, mes, n));
    const cls = ["dia"];
    if (s < h) cls.push("passado");
    else if (oc.has(s)) cls.push("ocupado");
    if (d.ini && (s === d.ini || s === d.fim)) cls.push("sel");
    else if (d.ini && d.fim && s > d.ini && s < d.fim) cls.push("meio");
    dias += `<button class="${cls.join(" ")}" data-d="${s}" ${s < h ? "disabled" : ""}>${n}</button>`;
  }
  const nomeMes = d.mes.toLocaleDateString("pt-BR", { month: "long" });

  $("#cal").innerHTML = `<div class="cal">
    <div class="cal-topo">
      <button data-mes="-1" ${podeVoltar ? "" : "disabled"} aria-label="Mês anterior">‹</button>
      <h3>${nomeMes[0].toUpperCase() + nomeMes.slice(1)} de ${ano}</h3>
      <button data-mes="1" ${podeAvancar ? "" : "disabled"} aria-label="Próximo mês">›</button>
    </div>
    <div class="cal-semana">${["D", "S", "T", "Q", "Q", "S", "S"].map((x) => `<div>${x}</div>`).join("")}</div>
    <div class="cal-dias">${dias}</div>
    <div class="legenda">
      <span><i style="background:var(--livre-bg);border:1px solid var(--livre)"></i>Livre</span>
      <span><i style="background:var(--ocupado-bg);border:1px solid var(--ocupado)"></i>Ocupado</span>
    </div>
  </div>`;

  $("#cal").onclick = (ev) => {
    const nav = ev.target.closest("[data-mes]");
    if (nav && !nav.disabled) { d.mes = new Date(ano, mes + Number(nav.dataset.mes), 1); renderCalendario(); return; }
    const b = ev.target.closest(".dia[data-d]"); if (!b || b.disabled) return;
    escolherDia(b.dataset.d);
  };
  renderResumo();
}

function escolherDia(s) {
  const d = E.det;
  const oc = E.ocupadas.get(d.m.id) || new Set();
  // 1º toque (ou recomeço): entrada. Precisa ser um dia livre.
  if (!d.ini || d.fim || s <= d.ini) {
    if (oc.has(s)) { aviso("Esse dia já está ocupado. Escolha um dia livre para a entrada."); return; }
    d.ini = s; d.fim = null;
  } else {
    // 2º toque: saída. Todas as noites entre entrada e saída precisam estar livres.
    if (!livreNoPeriodo(d.m, d.ini, s)) {
      aviso("Há dias ocupados nesse período. Escolha outra data de saída.");
      return;
    }
    d.fim = s;
  }
  renderCalendario();
  renderAcao();
}

function renderResumo() {
  const d = E.det, el = $("#resumo"); if (!el) return;
  if (!d.ini) { el.innerHTML = ""; return; }
  if (!d.fim) { el.innerHTML = `<div class="resumo-datas">Entrada: <b>${dataLonga(d.ini)}</b><br>Agora toque no dia de <b>saída</b>.</div>`; return; }
  const n = noites(d.ini, d.fim);
  const ref = d.m.valor_diaria ? `<br>Valor de referência: <b>${moeda(d.m.valor_diaria * n)}</b> <span style="color:var(--muted)">(${n} × ${moeda(d.m.valor_diaria)})</span>` : "";
  el.innerHTML = `<div class="resumo-datas">
    Entrada: <b>${dataLonga(d.ini)}</b><br>Saída: <b>${dataLonga(d.fim)}</b><br>${plural(n, "diária", "diárias")}${ref}
    <br><span style="color:var(--muted);font-size:13px">O valor final é confirmado no atendimento.</span>
  </div>`;
}

/* ---------- barra de ação (WhatsApp) ---------- */
function renderAcao() {
  const d = E.det, m = d.m;
  const wpp = numeroDestino();
  const box = $("#detalhe-acao");
  if (!wpp) {
    box.innerHTML = `<div class="linha"><div class="info">Para mais informações, fale com ${esc(E.imob.nome)}.</div></div>`;
    return;
  }
  let info, rotulo, pronto = true;
  if (d.modo === "temporada") {
    if (d.ini && d.fim) {
      info = `<b>${dataCurta(d.ini)} → ${dataCurta(d.fim)}</b>${plural(noites(d.ini, d.fim), "diária", "diárias")}`;
      rotulo = "Pedir orçamento";
    } else {
      info = `<b>${m.valor_diaria ? moeda(m.valor_diaria) + " / diária" : "Escolha as datas"}</b>${d.ini ? "Falta o dia de saída" : "Escolha as datas no calendário"}`;
      rotulo = "Escolher datas"; pronto = false;
    }
  } else if (d.modo === "alugar") {
    const v = m.mensal ? m.valor_mensal : m.valor_anual;
    info = `<b>${v ? moeda(v) + " / mês" : "Valor sob consulta"}</b>Aluguel`;
    rotulo = "Tenho interesse";
  } else {
    const v = m.venda ? m.valor_venda : m.valor_prevenda;
    info = `<b>${v ? moeda(v) : "Sob consulta"}</b>${m.venda ? "Venda" : "Lançamento"}`;
    rotulo = "Tenho interesse";
  }
  box.innerHTML = `<div class="linha">
    <div class="info">${info}</div>
    <button class="btn ${pronto ? "btn-wpp" : "btn-destaque"}" id="btn-acao">${pronto ? "💬 " : ""}${rotulo}</button>
  </div>`;
  $("#btn-acao").onclick = () => {
    if (!pronto) { $("#secao-datas")?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    enviarWhatsApp();
  };
}

// Mensagem sem emojis (alguns celulares mostram "?" no lugar): só *negrito*, _itálico_ e listas com "-"
function enviarWhatsApp() {
  const d = E.det, m = d.m;
  const sub = [m.codigo ? `Cód. ${m.codigo}` : "", m.tipo, m.bairro].filter(Boolean).join(" - ");
  const linhas = [`Olá! Vi no site da *${E.imob.nome}* e tenho interesse neste imóvel:`, "", `*${m.titulo}*`];
  if (sub) linhas.push(`_${sub}_`);
  if (d.modo === "temporada") {
    const pessoas = parseInt($("#orc-pessoas")?.value || d.pessoas, 10);
    const nome = ($("#orc-nome")?.value || d.nome).trim();
    linhas.push(
      "", "*Pedido de orçamento - Temporada*",
      `- Entrada: ${dataLonga(d.ini)}`,
      `- Saída: ${dataLonga(d.fim)}`,
      `- Diárias: ${noites(d.ini, d.fim)}`,
    );
    if (pessoas > 0) linhas.push(`- Pessoas: ${pessoas}`);
    if (nome) linhas.push(`- Nome: ${nome}`);
  } else if (d.modo === "alugar") {
    linhas.push("", "Gostaria de saber mais sobre o *aluguel*.");
  } else {
    linhas.push("", `Gostaria de saber mais sobre a *${m.venda ? "compra" : "pré-venda"}*.`);
  }
  linhas.push("", "_Link do imóvel:_", linkImovel(m));
  abrirWhatsApp(linkWpp(linhas.join("\n")));
}

// Qualquer link de WhatsApp da página segue a mesma regra do abrirWhatsApp
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-wpp]"); if (!a) return;
  ev.preventDefault(); abrirWhatsApp(a.href);
});

/* ---------------- início ---------------- */
iniciar();

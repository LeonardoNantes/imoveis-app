/* =====================================================================
   PRÉVIA DO LINK (WhatsApp, Instagram, Facebook...)
   Quem gera a "carinha" do link (foto, título e descrição) não abre o site
   de verdade, só lê o começo da página. Este arquivo roda na Vercel antes de
   entregar a página e coloca ali a foto e a frase do corretor, da
   imobiliária ou do imóvel, conforme o link.
   ===================================================================== */
export const config = { matcher: "/" };

const SB = "https://nmeccefdwkknhlvkxljt.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tZWNjZWZkd2trbmhsdmt4bGp0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3OTM5NjAsImV4cCI6MjEwODM2OTk2MH0.xAv8cxPmQF6B86ivC68IUHiNS7WVGAXarGZHgp4sXUI";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json" };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const moeda = (v) => "R$ " + Number(v).toLocaleString("pt-BR", { maximumFractionDigits: Number(v) % 1 ? 2 : 0 });
const plural = (n, s, p) => `${n} ${n == 1 ? s : p}`;

async function get(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H });
  if (!r.ok) return null;
  return r.json();
}
async function rpc(nome, args) {
  const r = await fetch(`${SB}/rest/v1/rpc/${nome}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  if (!r.ok) return null;
  return r.json();
}

async function montarMeta(url) {
  const c = url.searchParams.get("c"), m = url.searchParams.get("m");
  let i = url.searchParams.get("i");
  let corretor = null;
  if (c) {
    const d = await rpc("loc_corretor_publico", { p_slug: c });
    corretor = d?.[0] || null;
    if (corretor) i = corretor.imobiliaria_slug;
  }
  if (!i) return null;
  const imobs = await get(`loc_imobiliarias?slug=eq.${encodeURIComponent(i)}&ativo=eq.true&select=id,nome,slogan,descricao_link,og_url,capa_mobile_url,capa_url,logo_url&limit=1`);
  const imob = imobs?.[0];
  if (!imob) return null;
  const imgImob = imob.og_url || imob.capa_mobile_url || imob.capa_url || imob.logo_url;

  // Link de um imóvel específico (botão compartilhar)
  if (m && /^[0-9a-f-]{36}$/i.test(m)) {
    const lista = await get(`loc_imoveis?id=eq.${m}&imobiliaria_id=eq.${imob.id}&ativo=eq.true&select=titulo,codigo,tipo,bairro,quartos,suites,capacidade,temporada,valor_diaria,mensal,valor_mensal,venda,valor_venda,loc_fotos(url,ordem)&limit=1`);
    const im = lista?.[0];
    if (im) {
      const partes = [im.tipo, im.bairro,
        im.quartos != null ? plural(im.quartos, "quarto", "quartos") : null,
        im.suites ? plural(im.suites, "suíte", "suítes") : null,
        im.capacidade ? `até ${im.capacidade} pessoas` : null].filter(Boolean);
      const preco = im.temporada && im.valor_diaria ? `${moeda(im.valor_diaria)}/diária`
        : im.mensal && im.valor_mensal ? `${moeda(im.valor_mensal)}/mês`
        : im.venda && im.valor_venda ? moeda(im.valor_venda) : null;
      const foto = (im.loc_fotos || []).sort((a, b) => a.ordem - b.ordem)[0]?.url;
      return {
        titulo: `${im.titulo}${im.codigo ? ` · Cód. ${im.codigo}` : ""}`,
        descricao: [partes.join(" · "), preco].filter(Boolean).join(" — ") + ` | ${imob.nome}${corretor ? ` · ${corretor.nome}` : ""}`,
        imagem: foto || imgImob,
        site: imob.nome,
      };
    }
  }

  if (corretor) {
    return {
      titulo: `${corretor.nome} · ${imob.nome}`,
      descricao: corretor.frase_link || `Imóveis para temporada, aluguel e venda com ${corretor.nome}. Veja fotos, datas livres e peça seu orçamento pelo WhatsApp.`,
      imagem: corretor.foto_og_url || corretor.foto_url || imgImob,
      site: imob.nome,
    };
  }
  return {
    titulo: imob.nome,
    descricao: imob.descricao_link || imob.slogan || "Imóveis para temporada, aluguel e venda. Veja fotos, datas livres e peça seu orçamento pelo WhatsApp.",
    imagem: imgImob,
    site: imob.nome,
  };
}

export default async function middleware(request) {
  const url = new URL(request.url);
  if (!url.searchParams.get("c") && !url.searchParams.get("i")) return; // sem link de imobiliária: página normal
  try {
    const [pagina, meta] = await Promise.all([fetch(new URL("/index.html", url)), montarMeta(url)]);
    if (!pagina.ok || !meta) return;
    let html = await pagina.text();
    const tags = `
  <title>${esc(meta.titulo)}</title>
  <meta name="description" content="${esc(meta.descricao)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${esc(meta.site)}">
  <meta property="og:title" content="${esc(meta.titulo)}">
  <meta property="og:description" content="${esc(meta.descricao)}">
  <meta property="og:url" content="${esc(url.toString())}">
  ${meta.imagem ? `<meta property="og:image" content="${esc(meta.imagem)}">
  <meta property="og:image:secure_url" content="${esc(meta.imagem)}">
  <meta name="twitter:image" content="${esc(meta.imagem)}">` : ""}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(meta.titulo)}">
  <meta name="twitter:description" content="${esc(meta.descricao)}">`;
    html = html
      .replace(/<title>[\s\S]*?<\/title>/i, "")
      .replace(/<meta name="description"[^>]*>/i, "")
      .replace(/<!-- PREVIA-INICIO -->[\s\S]*?<!-- PREVIA-FIM -->/i, "")
      .replace(/<\/head>/i, `${tags}\n</head>`);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (_) {
    return; // qualquer problema: entrega a página normal
  }
}

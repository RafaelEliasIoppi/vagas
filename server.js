import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static("public"));

/** Heurística de relevância para vagas de estágio em dev */
function isRelevant(item) {
  const t = `${item.title} ${item.description}`.toLowerCase();
  const hasIntern = /(estágio|estagio|internship)/i.test(t);
  const hasDev = /(desenvolvedor|desenvolvimento|developer|programador|software|backend|front\s*end|frontend|full\s*stack|qa|mobile)/i.test(t);
  return (hasIntern || hasDev);
}

/** Boost por domínios de vagas */
function domainScore(url = "") {
  const u = url.toLowerCase();
  const boosts = [
    "linkedin.com/jobs",
    "indeed.com",
    "indeed.com.br",
    "gupy.io",
    "vagas.com.br",
    "trampos.co",
    "greenhouse.io",
    "lever.co",
    "workable.com",
    "jobvite.com",
    "empregos.com.br"
  ];
  if (boosts.some(d => u.includes(d))) return 3;
  if (/duckduckgo\.com/.test(u)) return 0; // informativo
  return 1;
}

/** Extrai tecnologias e cidades */
function extractTags(text) {
  const t = text.toLowerCase();
  const techs = [
    "java","javascript","typescript","node","react","next.js","vue","angular","svelte",
    "python","django","flask","fastapi",
    "c#",".net","asp.net","entity framework",
    "ruby","rails","php","laravel","symfony",
    "go","kotlin","swift",
    "sql","postgres","mysql","sqlite","mongodb",
    "git","docker","kubernetes","ci/cd",
    "aws","azure","gcp"
  ];
  const cities = [
    "porto alegre","caxias do sul","são leopoldo","novo hamburgo","pelotas","santa maria",
    "florianópolis","joinville","blumenau","chapecó","itajai",
    "curitiba","londrina","maringá","ponta grossa"
  ];
  const foundTechs = techs.filter(x => t.includes(x));
  const foundCities = cities.filter(x => t.includes(x));
  return { techs: [...new Set(foundTechs)], cities: [...new Set(foundCities)] };
}

/** Deduplica por URL/título */
function dedupe(items) {
  const seenUrl = new Set();
  const seenTitle = new Set();
  const out = [];
  for (const it of items) {
    const u = (it.url || "").toLowerCase();
    const tt = (it.title || "").toLowerCase();
    const byUrl = u && !seenUrl.has(u);
    const byTitle = tt && !seenTitle.has(tt);
    if (byUrl || byTitle) {
      if (u) seenUrl.add(u);
      if (tt) seenTitle.add(tt);
      out.push(it);
    }
  }
  return out;
}

/** Capitalização simples */
function capitalize(s){ return s.replace(/\b\w/g, c => c.toUpperCase()); }

/** Fallback de resumo local */
function localSummary(results) {
  const techCount = {};
  const cityCount = {};
  const best = results.slice(0, 5);

  for (const r of results) {
    for (const t of r.tags?.techs || []) techCount[t] = (techCount[t] || 0) + 1;
    for (const c of r.tags?.cities || []) cityCount[c] = (cityCount[c] || 0) + 1;
  }
  const topTech = Object.entries(techCount).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>`${k} (${v})`);
  const topCity = Object.entries(cityCount).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${capitalize(k)} (${v})`);

  const lines = [];
  lines.push(topTech.length ? `Tecnologias mais citadas: ${topTech.join(", ")}.` : "Tecnologias mais citadas: não identificadas.");
  lines.push(topCity.length ? `Cidades em destaque: ${topCity.join(", ")}.` : "Cidades em destaque: não identificadas.");
  lines.push("Top 5 oportunidades:");
  best.forEach((b, i) => {
    lines.push(`${i+1}. ${b.title} — ${b.url}`);
  });
  lines.push("Requisitos comuns de estágio: conhecimentos básicos na stack citada, versionamento (Git), lógica de programação, bancos de dados, comunicação e trabalho em equipe.");
  lines.push("Dicas: mantenha projetos no GitHub e adapte o currículo às tecnologias exigidas.");

  return lines.join("\n");
}

/** Busca usando DuckDuckGo (proxy) */
async function searchDuckDuckGo(q) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_redirect=1`;
  const response = await fetch(url);
  const data = await response.json();
  const raw = (data.RelatedTopics || []).flatMap(rt => {
    if (rt.Topics) return rt.Topics;
    return [rt];
  }).map(rt => ({
    title: rt?.Text || "",
    description: (rt?.Result || "").replace(/<[^>]+>/g, "") || rt?.Text || "",
    url: rt?.FirstURL || ""
  }));
  return raw;
}

/** Opcional: Busca via Google Custom Search (se chaves estiverem no .env) */
async function searchGoogleCSE(q) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX_ID;
  if (!apiKey || !cx) return null;
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(q)}&key=${apiKey}&cx=${cx}`;
  const response = await fetch(url);
  const data = await response.json();
  const items = (data.items || []).map(item => ({
    title: item.title || "",
    description: item.snippet || "",
    url: item.link || ""
  }));
  return items;
}

/** Rota de busca (proxy + enriquecimento) */
app.get("/search", async (req, res) => {
  const qRaw = req.query.q || "vagas estágio desenvolvimento software região sul Brasil";
  // força termos úteis para evitar ruídos (“Java ilha” etc.)
  const q = `${qRaw} site:linkedin.com/jobs OR site:gupy.io OR site:vagas.com.br OR site:indeed.com.br`;

  try {
    // tenta Google CSE se disponível; senão DuckDuckGo
    let raw = null;
    try {
      raw = await searchGoogleCSE(q);
    } catch {}
    if (!raw || raw.length === 0) {
      raw = await searchDuckDuckGo(q);
    }

    let items = raw
      .filter(it => it.url && it.title)
      .filter(isRelevant)
      .map(it => {
        const tags = extractTags(`${it.title} ${it.description}`);
        const score = domainScore(it.url) + (tags.techs.length ? 1 : 0) + (tags.cities.length ? 1 : 0);
        return { ...it, tags, score };
      });

    items = dedupe(items).sort((a,b)=>b.score - a.score);

    // Se muito fraco, faz fallback: mantém pelo menos alguns itens informativos
    if (items.length < 5) {
      const informative = raw
        .filter(it => it.url && it.title)
        .map(it => ({...it, tags: extractTags(`${it.title} ${it.description}`), score: domainScore(it.url)}));
      const merged = dedupe([...items, ...informative]).sort((a,b)=>b.score - a.score).slice(0,12);
      items = merged;
    }

    res.json({ results: items.slice(0, 12) });
  } catch (error) {
    console.error("Erro /search:", error);
    res.status(500).json({ erro: "Falha ao buscar vagas" });
  }
});

/** Rota de refino com Gemini (prompt robusto) */
app.post("/refine", async (req, res) => {
  const { results } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ erro: "Sem resultados para refinar" });
  }
  if (!apiKey) {
    return res.status(400).json({ erro: "Gemini API Key não configurada" });
  }

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

  const prompt = `
Você é um assistente de carreira. Com base nas vagas abaixo (estágio em desenvolvimento de software na Região Sul do Brasil),
produza um resumo objetivo, útil e estruturado:

1. Tecnologias mais citadas, com contagem.
2. Cidades/locais em destaque, com contagem.
3. Classificação das vagas por área (Backend, Frontend, Fullstack, Mobile, QA).
4. Top 5 oportunidades: cite Título e Link (se houver empresa, inclua).
5. Bullets de requisitos comuns (linguagens, frameworks, versionamento, devops, soft skills).
6. Alerta se alguma vaga exigir conhecimentos mais avançados para estágio (Docker/Kubernetes/Cloud).
7. Duas dicas acionáveis para candidatura (portfólio, GitHub, currículo, cartas).

Vagas (JSON):
${JSON.stringify(results.map(r => ({
  titulo: r.title,
  descricao: r.description,
  link: r.url,
  tecnologias: r.tags?.techs || [],
  cidades: r.tags?.cities || []
})), null, 2)}
`;

  const body = { contents: [{ parts: [{ text: prompt }] }] };

  try {
    const response = await fetch(`${endpoint}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    const output = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    res.json({ resumo: output || localSummary(results) });
  } catch (error) {
    console.error("Erro /refine:", error);
    res.status(200).json({ resumo: localSummary(results) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});

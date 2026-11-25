type Criterion = { id: string; name: string; description: string };
type Category = { id: string; name: string; description: string; criteria: Criterion[] };
type Model = { id: string; name: string; provider: string };
type Rating = { scores: Record<string, number>; notes: string };
type Review = Rating & { submittedAt: number };
type Workspace = { version: 2; reviews: Record<string, Review>; drafts: Record<string, Rating> };

const STORAGE_KEY = "benchline.reviews.v1";
const LEGACY_KEY = "benchline.workspace.v2";
const categories: Category[] = JSON.parse((document.getElementById("fixed-rubric") as HTMLScriptElement).textContent || "[]");
const MODEL_CATALOG_URL = "./models.json";
let catalog: Model[] = [];
let modelIds = new Set<string>();
let catalogLoaded = false;
let catalogError = "";
const criterionIds = new Set(categories.flatMap(category => category.criteria.map(criterion => criterion.id)));
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char] || char));
const safeRating = (value: any): Rating => ({
  scores: Object.fromEntries(Object.entries(value?.scores || {}).filter(([key, score]) =>
    criterionIds.has(key) && typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 10)) as Record<string, number>,
  notes: typeof value?.notes === "string" ? value.notes.slice(0, 20000) : ""
});
const normalizeWorkspace = (value: any): Workspace => {
  const reviews: Record<string, Review> = {};
  const drafts: Record<string, Rating> = {};
  for (const id of modelIds) {
    if (value?.reviews?.[id]) {
      const rating = safeRating(value.reviews[id]);
      reviews[id] = { ...rating, submittedAt: typeof value.reviews[id].submittedAt === "number" ? value.reviews[id].submittedAt : Date.now() };
    }
    if (value?.drafts?.[id]) drafts[id] = safeRating(value.drafts[id]);
  }
  return { version: 2, reviews, drafts };
};
const loadWorkspace = (): Workspace => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return normalizeWorkspace(JSON.parse(stored));
    const old = localStorage.getItem(LEGACY_KEY);
    if (old) {
      const saved = JSON.parse(old);
      const drafts: Record<string, Rating> = {};
      if (Array.isArray(saved.models)) for (const model of saved.models) {
        if (!modelIds.has(model.id)) continue;
        const rating = safeRating(model);
        if (Object.keys(rating.scores).length || rating.notes) drafts[model.id] = rating;
      }
      return { version: 2, reviews: {}, drafts };
    }
  } catch { }
  return { version: 2, reviews: {}, drafts: {} };
};

let workspace: Workspace = { version: 2, reviews: {}, drafts: {} };
let selectedModelId: string | null = null;
let sortBy = "overall";
let searchQuery = "";
let feedback = "";

const save = (): void => localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
const selectedModel = (): Model | undefined => catalog.find(model => model.id === selectedModelId);
const average = (values: number[]): number | null => values.length ? values.reduce((sum, score) => sum + score, 0) / values.length : null;
const categoryScores = (rating: Rating, category: Category): number[] => category.criteria
  .map(criterion => rating.scores[criterion.id])
  .filter((score): score is number => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 10);
const categoryScore = (rating: Rating, category: Category): number | null => average(categoryScores(rating, category));
const overallScore = (rating: Rating): number | null => average(categories
  .map(category => categoryScore(rating, category))
  .filter((score): score is number => score !== null));
const scoreLabel = (value: number | null): string => value === null ? "—" : value.toFixed(1);
const currentDraft = (id: string): Rating => workspace.drafts[id] || workspace.reviews[id] || { scores: {}, notes: "" };
const updateDraft = (id: string, updater: (draft: Rating) => void): void => {
  const previous = currentDraft(id);
  const draft = { scores: { ...previous.scores }, notes: previous.notes };
  updater(draft);
  workspace.drafts[id] = draft;
  save();
};

function render(): void {
  renderSort();
  renderLeaderboard();
  renderRatingEditor();
}

function renderSort(): void {
  const options = [{ value: "overall", label: "Overall" }, ...categories.map(category => ({ value: category.id, label: category.name })), { value: "name", label: "Name" }];
  if (!options.some(option => option.value === sortBy)) sortBy = "overall";
  element<HTMLSelectElement>("sort").innerHTML = options
    .map(option => `<option value="${escapeHtml(option.value)}" ${option.value === sortBy ? "selected" : ""}>Sort: ${escapeHtml(option.label)}</option>`).join("");
}

function renderLeaderboard(): void {
  if (!catalogLoaded || catalogError) {
    element<HTMLElement>("model-count").textContent = catalogLoaded ? "Unavailable" : "Loading";
    element<HTMLElement>("leaderboard-table").innerHTML = `<div class="empty"><h3>${catalogError ? "Catalog unavailable" : "Loading models"}</h3><p>${catalogError ? escapeHtml(catalogError) : "Reading models.json"}</p></div>`;
    return;
  }
  const count = Object.keys(workspace.reviews).length;
  element<HTMLElement>("model-count").textContent = `${catalog.length} ${catalog.length === 1 ? "model" : "models"} · ${count} ${count === 1 ? "personal review" : "personal reviews"}`;
  const results = catalog.filter(model => `${model.name} ${model.provider}`.toLowerCase().includes(searchQuery.toLowerCase()));
  if (sortBy === "name") results.sort((a, b) => a.name.localeCompare(b.name));
  else {
    const score = (model: Model): number | null => {
      const review = workspace.reviews[model.id];
      if (!review) return null;
      return sortBy === "overall" ? overallScore(review) : categoryScore(review, categories.find(category => category.id === sortBy) || categories[0]);
    };
    results.sort((a, b) => {
      const aScore = score(a);
      const bScore = score(b);
      if (aScore === null && bScore !== null) return 1;
      if (aScore !== null && bScore === null) return -1;
      return (bScore ?? 0) - (aScore ?? 0) || a.name.localeCompare(b.name);
    });
  }
  if (!results.length) {
    element<HTMLElement>("leaderboard-table").innerHTML = catalog.length
      ? `<div class="empty"><h3>No matching models</h3><p>Try a different search.</p></div>`
      : `<div class="empty"><h3>No models available</h3><p>The model catalog is maintained by the site owner.</p></div>`;
    return;
  }
  element<HTMLElement>("leaderboard-table").innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th>Model</th>${categories.map(category => `<th>${escapeHtml(category.name)}</th>`).join("")}<th>My rating</th></tr></thead>
    <tbody>${results.map(model => {
      const review = workspace.reviews[model.id];
      return `<tr class="${selectedModelId === model.id ? "is-selected" : ""}">
        <td><button type="button" class="model-name" data-action="select-model" data-id="${escapeHtml(model.id)}">${escapeHtml(model.name)}</button>${model.provider ? `<div class="model-provider">${escapeHtml(model.provider)}</div>` : ""}</td>
        ${categories.map(category => {
          const score = review ? categoryScore(review, category) : null;
          return `<td><div class="score ${score === null ? "muted" : ""}">${scoreLabel(score)}</div>${score !== null && review ? `<div class="score-meta">${categoryScores(review, category).length}/${category.criteria.length}</div>` : ""}</td>`;
        }).join("")}
        <td><span class="score ${review && overallScore(review) !== null ? "" : "muted"}">${review ? scoreLabel(overallScore(review)) : "—"}</span></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}

function renderRatingEditor(): void {
  if (!catalogLoaded || catalogError) {
    element<HTMLElement>("rating-editor").innerHTML = `<div class="panel-header"><h2>Your review</h2></div><div class="empty"><p>${catalogError ? "The model catalog could not be loaded." : "Loading models"}</p></div>`;
    return;
  }
  const model = selectedModel();
  if (!model) {
    element<HTMLElement>("rating-editor").innerHTML = `<div class="panel-header"><h2>Your review</h2></div><div class="empty"><h3>Nothing selected</h3><p>Select an available model to review it.</p></div>`;
    return;
  }
  const draft = currentDraft(model.id);
  const submitted = workspace.reviews[model.id];
  const overall = overallScore(draft);
  element<HTMLElement>("rating-editor").innerHTML = `
    <div class="rating-header">
      <span class="eyebrow">Your review</span>
      <div class="rating-top"><div class="rating-title">${escapeHtml(model.name)}</div><div class="rating-summary">${scoreLabel(overall)}<small> / 10</small></div></div>
      <div class="rating-meta"><span>${escapeHtml(model.provider)}</span><span>${submitted ? "Review saved locally" : "Not submitted"}</span></div>
    </div>
    <div class="rating-body">
      ${categories.map(category => {
        const mean = categoryScore(draft, category);
        return `<section class="rating-group">
          <div class="rating-group-title"><h3>${escapeHtml(category.name)}</h3><span class="score ${mean === null ? "muted" : ""}">${scoreLabel(mean)}</span></div>
          ${category.description ? `<p class="rating-group-subtitle">${escapeHtml(category.description)}</p>` : ""}
          ${category.criteria.map(criterion => {
            const score = draft.scores[criterion.id];
            return `<label class="criterion-row"><span><span class="criterion-name">${escapeHtml(criterion.name)}</span>${criterion.description ? `<span class="criterion-description" style="display:block">${escapeHtml(criterion.description)}</span>` : ""}</span><input class="score-input" type="number" inputmode="decimal" min="0" max="10" step="0.1" placeholder="—" aria-label="${escapeHtml(category.name)}: ${escapeHtml(criterion.name)} score" data-score-id="${escapeHtml(criterion.id)}" value="${typeof score === "number" ? score : ""}"></label>`;
          }).join("")}
        </section>`;
      }).join("")}
      <div class="rating-notes"><label class="field-label" for="model-notes">Review notes (optional)</label><textarea id="model-notes" class="long-field" placeholder="Observations, tests, or examples">${escapeHtml(draft.notes)}</textarea>
        <div class="review-actions"><button type="button" class="button" data-action="submit-review">${submitted ? "Update my review" : "Submit review"}</button><span class="review-state">${submitted ? "Your existing review will be replaced." : "At least one score is required."}</span></div>
        ${feedback ? `<p class="feedback ${feedback.startsWith("Enter") ? "error" : ""}" role="status">${escapeHtml(feedback)}</p>` : ""}
        <div class="scale-note">Scores are 0–10. Empty criteria are excluded. Reviews are stored locally in this prototype.</div>
      </div>
    </div>`;
}

function submitReview(): void {
  if (!selectedModelId || !modelIds.has(selectedModelId)) return;
  const draft = safeRating(currentDraft(selectedModelId));
  if (!Object.keys(draft.scores).length) {
    feedback = "Enter at least one score before submitting.";
    renderRatingEditor();
    return;
  }
  workspace.reviews[selectedModelId] = { ...draft, submittedAt: Date.now() };
  delete workspace.drafts[selectedModelId];
  save();
  feedback = "Review saved in this browser. Public submission requires a backend.";
  render();
}

document.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-action]");
  if (!button) return;
  if (button.dataset.action === "select-model") {
    selectedModelId = button.dataset.id || null;
    feedback = "";
    renderLeaderboard();
    renderRatingEditor();
  }
  if (button.dataset.action === "submit-review") submitReview();
});

document.addEventListener("change", event => {
  const target = event.target as HTMLInputElement;
  if (!target.matches("[data-score-id]") || !selectedModelId) return;
  const id = target.dataset.scoreId || "";
  if (!criterionIds.has(id)) return;
  updateDraft(selectedModelId, draft => {
    if (!target.value.trim()) delete draft.scores[id];
    else {
      const score = Number(target.value);
      if (Number.isFinite(score)) draft.scores[id] = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
    }
  });
  feedback = "";
  renderRatingEditor();
});

document.addEventListener("input", event => {
  const target = event.target as HTMLTextAreaElement;
  if (target.id !== "model-notes" || !selectedModelId) return;
  updateDraft(selectedModelId, draft => { draft.notes = target.value; });
});

element<HTMLInputElement>("search").addEventListener("input", event => {
  searchQuery = (event.target as HTMLInputElement).value;
  renderLeaderboard();
});
element<HTMLSelectElement>("sort").addEventListener("change", event => {
  sortBy = (event.target as HTMLSelectElement).value;
  renderLeaderboard();
});

async function loadCatalog(): Promise<void> {
  try {
    const response = await fetch(MODEL_CATALOG_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("Request failed");
    const data: unknown = await response.json();
    if (!Array.isArray(data) || data.some(item =>
      !item || typeof item.id !== "string" || typeof item.name !== "string" ||
      typeof item.provider !== "string" || !item.id.trim() || !item.name.trim())) {
      throw new Error("Invalid model catalog");
    }
    const ids = data.map(item => item.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate model IDs");
    catalog = data.map(({ id, name, provider }) => ({ id, name, provider }));
    modelIds = new Set(ids);
    workspace = loadWorkspace();
    selectedModelId = catalog[0]?.id ?? null;
  } catch {
    catalogError = "Check that models.json is next to Benchline.html and that the site is served over HTTP or HTTPS.";
  }
  catalogLoaded = true;
  render();
}

render();
void loadCatalog();

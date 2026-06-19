import sys, math, re, tempfile, os, datetime, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# city_chatbot imports gradio and anthropic at module top. The test fakes the
# Anthropic client and doesn't exercise a real Gradio launch, so stub both
# modules to avoid installing the full stack just to import the file.
if "gradio" not in sys.modules:
    g = types.ModuleType("gradio")
    class _ChatInterface:
        def __init__(self, *a, **kw): self.kwargs=kw
    g.ChatInterface = _ChatInterface
    sys.modules["gradio"] = g
if "anthropic" not in sys.modules:
    a = types.ModuleType("anthropic")
    a.Anthropic = object  # never instantiated; tests inject FakeClient
    sys.modules["anthropic"] = a

class FakeEmbedder:
    def __init__(self, model_name=None, device="cpu", **kw):
        self.dimension = 64; self.model_name = model_name or "fake"; self.query_instruction = ""
    def _vec(self, t):
        v=[0.0]*64
        for tok in re.findall(r"[a-z0-9]+",(t or "").lower()): v[hash(tok)%64]+=1.0
        n=math.sqrt(sum(x*x for x in v)) or 1.0; return [x/n for x in v]
    def embed_documents(self, ts): return [self._vec(t) for t in ts]
    def embed_query(self, t): return self._vec(t)

# Fake Anthropic client capturing calls
class _Block:
    def __init__(self, text): self.type="text"; self.text=text
class _Resp:
    def __init__(self, text): self.content=[_Block(text)]
class _Stream:
    def __init__(self, text): self._t=text
    def __enter__(self): return self
    def __exit__(self,*a): return False
    @property
    def text_stream(self):
        for w in self._t.split(): yield w+" "
class _Messages:
    def __init__(self): self.last_create=None; self.last_stream=None
    def create(self, **kw): self.last_create=kw; return _Resp("rewritten standalone query")
    def stream(self, **kw): self.last_stream=kw; return _Stream("Here is your answer about water.")
class FakeClient:
    def __init__(self): self.messages=_Messages()

import chromadb, city_chatbot

results=[]
def check(n,c): results.append((n,bool(c))); print(("PASS " if c else "FAIL ")+n)

db = tempfile.mkdtemp()
emb = FakeEmbedder()
coll = chromadb.PersistentClient(path=db).get_or_create_collection(name="cite_content", metadata={"hnsw:space":"cosine"})
# Two chunks of the SAME page (the FAQ) plus a different page (organics). The
# fragment on the first FAQ url must not split it from the second FAQ chunk.
docs=["Single-family residents get three free bulky item pickups per year.",
      "Multi-family residents also get three free collections per year.",
      "Republic Services provides bulky item collection to commercial businesses for a fee per collection."]
metas=[{"title":"Collection FAQ","url":"http://x/faqs#single","file_type":"html"},
       {"title":"Collection FAQ","url":"http://x/faqs","file_type":"html"},
       {"title":"Organics Recycling","url":"http://x/organics","file_type":"html"}]
coll.upsert(ids=["1","2","3"], embeddings=emb.embed_documents(docs), documents=docs, metadatas=metas)

class TestBot(city_chatbot.CityRAGChatbot):
    def __init__(self, db_path):
        self.model_name="sonnet"; self.rewrite_model="haiku"
        self.max_tokens=200; self.temperature=0.0; self.top_k_results=5
        self.min_score=0.0; self.max_history_messages=6; self.show_footer=True
        self.client=FakeClient(); self.embedder=FakeEmbedder()
        self.chroma_client=chromadb.PersistentClient(path=db_path)
        self.collection=self.chroma_client.get_or_create_collection(
            name="cite_content", metadata={"hnsw:space":"cosine"})

bot = TestBot(db)

# ---- source_id labeling -------------------------------------------------
search_results=[
    {"url":"http://x/faqs#single","title":"Collection FAQ","content":"single family","score":0.7,"file_type":"html"},
    {"url":"http://x/organics","title":"Organics Recycling","content":"commercial fee","score":0.6,"file_type":"html"},
    {"url":"http://x/faqs","title":"Collection FAQ","content":"multi family","score":0.9,"file_type":"html"},
]
context, sources = bot.format_context_and_sources(search_results)

check("context tags first chunk [S0]", "[S0] Title: Collection FAQ" in context)
check("context tags organics as a distinct id", "[S1] Title: Organics Recycling" in context)
check("URL embedded inside each context block", "URL: http://x/organics" in context)
# both FAQ chunks (with and without fragment) collapse to one source_id
faq_ids = set(re.findall(r"\[(S\d+)\] Title: Collection FAQ", context))
check("both FAQ chunks share ONE source id", faq_ids=={"S0"})
check("exactly two unique sources", len(sources)==2)
check("source ids are S0,S1 in first-seen order", [s["source_id"] for s in sources]==["S0","S1"])
check("dedup keeps the higher score for the page", abs(sources[0]["score"]-0.9)<1e-9)
check("fragment stripped from source url", sources[0]["url"]=="http://x/faqs")

# ---- model-facing source list carries the ids --------------------------
list(bot.generate_response("q", context, sources, []))
sys_prompt = bot.client.messages.last_stream["system"]
check("source list shows [S0] tag", "- [S0] Collection FAQ -> http://x/faqs" in sys_prompt)
check("source list shows [S1] tag", "- [S1] Organics Recycling -> http://x/organics" in sys_prompt)

# ---- date placeholder is filled with TODAY -----------------------------
today_str = datetime.date.today().strftime("%B %-d, %Y")
check("system prompt contains today's real date", today_str in sys_prompt)
check("old hardcoded June 18, 2026 date is gone", "June 18, 2026" not in sys_prompt)
check("no leftover format placeholder", "{today}" not in sys_prompt)

# ---- prompt renumbering / typo fixes -----------------------------------
check("no orphan sub-numbered rule 1.1", "1.1." not in sys_prompt)
check("rule 9 is the citation rule", re.search(r"9\. Every context block", sys_prompt) is not None)
check("typo 'you're info' fixed", "you're info" not in sys_prompt)
check("typo 'cant' fixed to cannot", "when you cant" not in sys_prompt)

# ---- end-to-end answer still streams + footer --------------------------
out = list(bot.chat_with_rag("how do I schedule a bulk trash pickup", []))
final = out[-1]
check("first turn prepends Gigi intro", out[0].startswith("Hi, I'm Gigi"))
check("answer streamed", "Here is your answer" in final)
check("footer renders markdown link for a retrieved page", "](http://x/" in final)
check("no bracket-in-url 404 pattern", "faqs]" not in final and "organics]" not in final)

print("\n=== %d/%d passed ===" % (sum(1 for _,ok in results if ok), len(results)))
sys.exit(1 if any(not ok for _,ok in results) else 0)
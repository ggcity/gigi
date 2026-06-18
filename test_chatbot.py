import sys, math, re, tempfile, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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
coll = chromadb.PersistentClient(path=db).get_or_create_collection(name="test_content", metadata={"hnsw:space":"cosine"})
docs=["Residents can pay their water bill online through the billing office.",
      "Apply for a building permit by submitting an application to planning."]
metas=[{"title":"Pay Water Bill","url":"http://x/water","file_type":"html"},
       {"title":"Permits","url":"http://x/permits.pdf","file_type":"pdf"}]
coll.upsert(ids=["1","2"], embeddings=emb.embed_documents(docs), documents=docs, metadatas=metas)

class TestBot(city_chatbot.CityRAGChatbot):
    def __init__(self, db_path):
        self.model_name="sonnet"; self.rewrite_model="haiku"
        self.max_tokens=200; self.temperature=0.0; self.top_k_results=3
        self.min_score=0.0; self.max_history_messages=6
        self.client=FakeClient(); self.embedder=FakeEmbedder()
        self.chroma_client=chromadb.PersistentClient(path=db_path)
        self.collection=self.chroma_client.get_or_create_collection(
            name="test_content", metadata={"hnsw:space":"cosine"})

bot = TestBot(db)

# history normalization: messages dicts and tuples
h = bot._normalize_history([{"role":"user","content":"a"},{"role":"assistant","content":"b"}])
check("normalize messages-format", h==[{"role":"user","content":"a"},{"role":"assistant","content":"b"}])
h2 = bot._normalize_history([("a","b")])
check("normalize tuple-format", h2==[{"role":"user","content":"a"},{"role":"assistant","content":"b"}])

# first turn: no rewrite call, intro prepended
out = list(bot.chat_with_rag("how do I pay my water bill", []))
check("first turn skips query rewrite", bot.client.messages.last_create is None)
check("first turn prepends Gigi intro", out[0].startswith("Hi, I'm Gigi"))
final = out[-1]
check("answer streamed after intro", "Here is your answer" in final)
check("sources footer uses markdown link", "[Pay Water Bill](http://x/water)" in final)
check("no bracket-in-url 404 pattern", "water]" not in final and "pdf]" not in final)

# follow-up turn: rewrite IS called, history passed to generation
bot.client.messages.last_create=None
hist=[{"role":"user","content":"how do I pay my water bill"},
      {"role":"assistant","content":"Use the billing office."}]
out2 = list(bot.chat_with_rag("what about for businesses?", hist))
check("follow-up triggers query rewrite (Haiku)", bot.client.messages.last_create is not None)
check("rewrite used the cheap model", bot.client.messages.last_create.get("model")=="haiku")
sent = bot.client.messages.last_stream["messages"]
check("history passed into generation", sent[:2]==hist and sent[-1]["role"]=="user")
check("follow-up does NOT repeat intro", not out2[0].startswith("Hi, I'm Gigi"))

# gradio interface still constructs
try:
    demo = bot.create_gradio_interface(); check("gradio ChatInterface constructs", demo is not None)
except Exception as e:
    check("gradio ChatInterface constructs", False); print("  ", e)

print("\n=== %d/%d passed ===" % (sum(1 for _,ok in results if ok), len(results)))
sys.exit(1 if any(not ok for _,ok in results) else 0)

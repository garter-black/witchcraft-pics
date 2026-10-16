import { reactorSwap, characterSwap, imageEdit } from "./src/generation/swap-edit";

const REF = "https://witchcraft.pics/__ref_probe__";

const graphs: Record<string, Record<string, unknown>> = {
  reactorSwap: reactorSwap(REF, REF),
  characterSwap: characterSwap("portrait photo", REF),
  imageEdit: imageEdit("sharper light", REF),
};

const HOST = "http://127.0.0.1:8188";

for (const [name, graph] of Object.entries(graphs)) {
  const res = await fetch(`${HOST}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: "validate-only" }),
  });
  const text = await res.text();
  if (res.ok) {
    const j = JSON.parse(text);
    console.log(`ACCEPTED  ${name}: prompt_id=${j.prompt_id} nodes=${Object.keys(graph).length}`);
    // do not actually render: interrupt immediately
    await fetch(`${HOST}/interrupt`, { method: "POST" }).catch(() => {});
  } else {
    console.log(`REJECTED  ${name}: HTTP ${res.status}`);
    try {
      const d = JSON.parse(text);
      console.log("   message:", d?.error?.message);
      for (const [nid, det] of Object.entries<any>(d.node_errors ?? {})) {
        for (const err of det.errors ?? []) {
          console.log(`   node ${nid}: ${err.message} :: ${err.details ?? ""}`);
        }
      }
    } catch {
      console.log("   ", text.slice(0, 400));
    }
  }
}
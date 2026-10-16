import json from "node:fs";
const oi: any = await (await fetch("http://127.0.0.1:8188/object_info")).json();
const node = oi["ReActorFaceSwap"];
console.log("swap_model options:", JSON.stringify(node.input.required.swap_model[0]));
console.log("face_restore options:", JSON.stringify(node.input.required.face_restore_model[0]));

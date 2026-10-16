export class BodyLimitError extends Error {
  constructor(){super('Request too large.');}
}

export async function readLimitedText(request:Request,maxBytes:number){
  if(Number(request.headers.get('content-length')||0)>maxBytes)throw new BodyLimitError();
  if(!request.body)return '';
  const reader=request.body.getReader(),decoder=new TextDecoder();
  let bytes=0,text='';
  try{
    while(true){
      const chunk=await reader.read();
      if(chunk.done)break;
      bytes+=chunk.value.byteLength;
      if(bytes>maxBytes){await reader.cancel();throw new BodyLimitError();}
      text+=decoder.decode(chunk.value,{stream:true});
    }
    return text+decoder.decode();
  }finally{reader.releaseLock();}
}

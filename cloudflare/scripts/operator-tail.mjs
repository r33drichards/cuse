/** Inspect complete JSON log records only. Never correlate an ID in one log
 * with a completion message in another, or return private log contents. */
export function operatorResult(text,id){
  let start=-1,depth=0,quoted=false,escape=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(start<0){if(c==='{'){start=i;depth=1;}continue;}
    if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}
    if(c==='{')depth++;
    if(c!=='}')continue;
    if(--depth!==0)continue;
    try{
      const event=JSON.parse(text.slice(start,i+1));
      for(const log of event.logs??[])for(const message of log.message??[]){
        if(typeof message!=='string')continue;
        try{const row=JSON.parse(message);if(row.id===id && ['operator_completed','operator_failed'].includes(row.code))return row.code.slice(9);}catch{}
      }
    }catch{}
    start=-1;
  }
}

/** Local lexical retrieval: Unicode words + overlapping CJK bigrams. No embedding/network call.
 * Values are passed as SQL parameters; the FTS expression contains quoted generated tokens only.
 */
export function searchTokens(value,max=30000){
  const terms=[];
  for(const token of String(value||'').normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu)||[]){
    if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)){
      const chars=[...token];if(chars.length===1)terms.push(chars[0]);
      for(let i=0;i<chars.length-1;i++)terms.push(chars[i]+chars[i+1]);
    }else terms.push(token);
    if(terms.length>=max)break;
  }
  return [...new Set(terms.slice(0,max))];
}
export const indexedText=doc=>searchTokens([doc.title,doc.name,doc.content,doc.input,doc.output].filter(Boolean).join('\n')).join(' ');
export const matchExpression=query=>searchTokens(query,32).map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');

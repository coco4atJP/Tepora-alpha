/** 七十二候: the five-day micro-seasons of the traditional Japanese calendar, shown as one quiet
 * line under the date. The dates are the fixed ones printed in calendars; they can differ by a day
 * from the astronomical year, so the line says nothing about the weather. Pure data and one lookup.
 */
const SEASON_ROWS=[
 [1,1,'冬至','雪下りて麦のびる'],[1,5,'小寒','芹乃ち栄う'],[1,10,'小寒','水泉動く'],[1,15,'小寒','雉始めて雊く'],
 [1,20,'大寒','款冬華さく'],[1,25,'大寒','水沢腹く堅し'],[1,30,'大寒','鶏始めて乳す'],
 [2,4,'立春','東風凍を解く'],[2,9,'立春','鶯鳴く'],[2,14,'立春','魚氷を上る'],
 [2,19,'雨水','土脉潤い起こる'],[2,24,'雨水','霞始めて靆く'],[3,1,'雨水','草木萌え動る'],
 [3,6,'啓蟄','蟄虫戸を啓く'],[3,11,'啓蟄','桃始めて笑う'],[3,16,'啓蟄','菜虫蝶と化る'],
 [3,21,'春分','雀始めて巣くう'],[3,26,'春分','桜始めて開く'],[3,31,'春分','雷乃ち声を発す'],
 [4,5,'清明','玄鳥至る'],[4,10,'清明','鴻雁北る'],[4,15,'清明','虹始めて見る'],
 [4,20,'穀雨','葭始めて生ず'],[4,25,'穀雨','霜止んで苗出ず'],[4,30,'穀雨','牡丹華さく'],
 [5,5,'立夏','蛙始めて鳴く'],[5,10,'立夏','蚯蚓出ずる'],[5,15,'立夏','竹笋生ず'],
 [5,21,'小満','蚕起きて桑を食む'],[5,26,'小満','紅花栄う'],[5,31,'小満','麦秋至る'],
 [6,6,'芒種','螳螂生ず'],[6,11,'芒種','腐草蛍と為る'],[6,16,'芒種','梅子黄なり'],
 [6,21,'夏至','乃東枯る'],[6,26,'夏至','菖蒲華さく'],[7,1,'夏至','半夏生ず'],
 [7,7,'小暑','温風至る'],[7,12,'小暑','蓮始めて開く'],[7,17,'小暑','鷹乃ち学を習う'],
 [7,23,'大暑','桐始めて花を結ぶ'],[7,28,'大暑','土潤いて溽し暑し'],[8,2,'大暑','大雨時々行る'],
 [8,7,'立秋','涼風至る'],[8,12,'立秋','寒蝉鳴く'],[8,17,'立秋','蒙霧升降す'],
 [8,23,'処暑','綿柎開く'],[8,28,'処暑','天地始めて粛し'],[9,2,'処暑','禾乃ち登る'],
 [9,8,'白露','草露白し'],[9,13,'白露','鶺鴒鳴く'],[9,18,'白露','玄鳥去る'],
 [9,23,'秋分','雷乃ち声を収む'],[9,28,'秋分','蟄虫戸を坯す'],[10,3,'秋分','水始めて涸る'],
 [10,8,'寒露','鴻雁来る'],[10,13,'寒露','菊花開く'],[10,18,'寒露','蟋蟀戸に在り'],
 [10,23,'霜降','霜始めて降る'],[10,28,'霜降','霎時施す'],[11,2,'霜降','楓蔦黄ばむ'],
 [11,7,'立冬','山茶始めて開く'],[11,12,'立冬','地始めて凍る'],[11,17,'立冬','金盞香し'],
 [11,22,'小雪','虹蔵れて見えず'],[11,27,'小雪','朔風葉を払う'],[12,2,'小雪','橘始めて黄なり'],
 [12,7,'大雪','閉塞く冬と成る'],[12,12,'大雪','熊穴に蟄る'],[12,17,'大雪','鱖魚群がる'],
 [12,22,'冬至','乃東生ず'],[12,27,'冬至','麋角解つる']
];
/** Calendar order from 1 January; 1 January starts the last 冬至 row, so no date falls before the first row. */
export const SEASONS=Object.freeze(SEASON_ROWS.map(([month,day,sekki,kou])=>Object.freeze({month,day,sekki,kou,key:month*100+day})));

/** The micro-season a local date falls in: {sekki, kou, index}. */
export function seasonOf(date=new Date()){
 const key=(date.getMonth()+1)*100+date.getDate();
 let index=0;
 for(let i=0;i<SEASONS.length;i++){if(SEASONS[i].key<=key)index=i;else break;}
 const {sekki,kou}=SEASONS[index];
 return {sekki,kou,index};
}
/** "秋分 ・ 水始めて涸る": the form shown on the home screen. */
export function seasonLine(date=new Date()){const s=seasonOf(date);return `${s.sekki} ・ ${s.kou}`;}

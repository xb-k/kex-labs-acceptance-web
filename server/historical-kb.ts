export interface HistoricalEraKnowledge {
  id: string
  eraLabel: string
  keywords: string[]
  chronology: string
  attire: string
  artifacts: string
  architecture: string
  lighting: string
  taboos: string
  visualCues: string
}

export const HISTORICAL_KNOWLEDGE_BASE: HistoricalEraKnowledge[] = [
  {
    id: 'han_jin',
    eraLabel: '汉晋 · 秦汉雄风与魏晋名士',
    keywords: ['秦', '汉', '三国', '魏晋', '南北朝', '长安', '洛阳', '建安', '竹林'],
    chronology: '秦汉至魏晋南北朝（约前221年—公元589年）：行郡县/九品中正制，竹简帛书与早中期纸卷并存，席地跪坐尚多，高足坐具尚在萌芽。',
    attire: '深衣、曲裾/直裾袍、交领右衽广袖，男子多著帻、进贤冠或漉酒巾；魏晋名士见褒衣博带与木屐。严禁出现唐代圆领袍、宋明襟式及近代扣饰。',
    artifacts: '漆耳杯、青铜博山炉、陶制/青瓷长颈瓶、竹简木牍、铜镜、油灯豆盘；饮食尚分餐制、矮案几（无清代高脚八仙桌）。',
    architecture: '高台阙楼、夯土版筑院墙、深出檐斗拱、简瓦屋面，室内多用屏风与席榻分隔空间，尚无琉璃彩瓦大面积应用。',
    lighting: '豆形青铜灯盏、松脂明火、粗布窗纱自然日影，画面偏重沉稳土红、墨黑、竹青与青铜氧化质感。',
    taboos: '禁止出现玉米、番薯、辣椒、番茄等明清后传入美洲作物；禁止出现高背靠椅、纸质线装书、雕花玻璃窗。',
    visualCues: 'Han-Jin dynasty lacquerware, low wooden dining table, bamboo slips, cross-collar right-lapel hemp and silk robes, rammed-earth courtyard, flickering bronze oil lamp'
  },
  {
    id: 'tang',
    eraLabel: '唐代 · 盛唐长安/敦煌丝路',
    keywords: ['唐', '盛唐', '天宝', '贞观', '开元', '长安', '敦煌', '丝路', '安史', '驿站', '胡姬'],
    chronology: '唐代（618—907年）：施行三省六部与府兵/驿传勘合制度，坊市分离并有暮鼓晨钟宵禁，长安西市胡商云集，丝路商旅往来不绝。',
    attire: '男子常服为圆领襕衫束蹀躞革带、头戴幞头或胡帽；女子盛唐常见齐胸襦裙/袒领半臂配披帛、高髻花钿；官吏依品阶著紫、绯、绿、青袍。',
    artifacts: '唐三彩、银鎏金錾花茶器/酒杯、秘色青瓷、卷轴装经卷（尚非线装书）、竹骨纸灯笼、长嘴执壶、琵琶与羯鼓。',
    architecture: '宏阔木构柱网、粗壮补间铺作斗拱、深远出檐配鸱吻、夯土坊墙与胡肆木廊；城市呈棋盘里坊制布局。',
    lighting: '素纸灯笼暖黄散射光、鎏金铜烛台、驿站油灯与黄沙逆光，呈浓郁金赭、朱红、石青与暖烟色温。',
    taboos: '严禁使用清代马褂辫子、明式高足交椅大杂烩、宋代瘦金体牌匾、辣椒炒菜、近代电灯玻璃灯罩。',
    visualCues: 'Tang dynasty round-collar silk robe, leather belt with jade ornaments, tri-color glazed ceramic ewer, paper lantern glow, grand timber bracket eaves, desert outpost dust'
  },
  {
    id: 'song',
    eraLabel: '宋代 · 汴梁/江南市井雅韵',
    keywords: ['宋', '北宋', '南宋', '汴梁', '临安', '清明上河', '建盏', '点茶', '书院', '江南'],
    chronology: '两宋（960—1279年）：宵禁废除、夜市兴盛，活字印刷与坊刻书业发达，文人雅集盛行点茶、焚香、挂画、插花四般闲事。',
    attire: '男装多见襕衫、直裰配东坡巾/直脚幞头；女装尚窄袖褙子配长裙（宋代褙子对襟外罩最具辨识度），衣料重素雅青碧、月白、茶褐暗纹。',
    artifacts: '黑釉建盏与茶筅（点茶而非清代散叶泡茶）、汝窑/龙泉青瓷、高足条案与圈椅/交椅、雕版线装/蝴蝶装典籍、竹伞与纸扇。',
    architecture: '细密灵巧的斗拱、歇山/悬山顶民居与临河瓦肆酒楼（欢门彩楼）、青砖灰瓦马头墙雏形，空间重留白透景。',
    lighting: '清冷天光、细雨江南漫反射、案头青瓷油灯微光，整体偏向低饱和靛蓝、松烟墨、青瓷灰与温润木色。',
    taboos: '严禁直接用紫砂壶抓散茶叶冲泡（紫砂普及于明清）；严禁满目大红大金清宫雕花；严禁出现玉米土豆辣椒。',
    visualCues: 'Song dynasty minimalist celadon ceramics, black Jian tea bowl with whisked froth, straight-lapel beizi cloak in muted slate blue, timber riverside teahouse in misty rain'
  },
  {
    id: 'ming',
    eraLabel: '明代 · 市井百态与海疆风云',
    keywords: ['明', '大明', '永乐', '万历', '锦衣卫', '江南', '漕运', '海疆', '戚继光', '徽商'],
    chronology: '明代（1368—1644年）：海禁与隆庆开关交替、白银货币化与江南市镇手工业繁盛，火器与冷兵器并用（火铳、鸟铳、戚家刀）。',
    attire: '男子常见交领道袍、贴里、曳撒与飞鱼服/补服，戴网巾、四方平定巾或大帽；女子常见立领长衫/比甲配马面裙（织金/妆花）。',
    artifacts: '青花瓷、宣德炉、黄花梨/紫檀明式榫卯家具（线条简练无清代繁琐雕花）、折扇、奏折奏疏文书、手摇纺车与木帆海船。',
    architecture: '高大徽派粉墙黛瓦与马头墙、青砖官署、硬山石库大门、城防砖石垛口与海岸烽燧。',
    lighting: '海港晨雾、官署高窗斜射光柱、蜡烛灯笼暖冷对比，色调注重青花蓝、黛瓦灰、暖黄铜与朱漆木色。',
    taboos: '严禁出现清代剃发金钱鼠尾辫与旗装旗头；严禁将明式素净家具与清式满雕紫檀混为一谈；注意火器应为前装火绳枪而非现代栓动步枪。',
    visualCues: 'Ming dynasty blue-and-white porcelain vase, austere rosewood joinery furniture, cross-collar daopao robe, horse-face pleated skirt, whitewashed courtyard walls under overcast sky'
  },
  {
    id: 'qing',
    eraLabel: '清代 · 京华风物与晚清沧桑',
    keywords: ['清', '康熙', '乾隆', '晚清', '京师', '四合院', '茶馆', '旗袍', '八旗', '洋务'],
    chronology: '清代（1636—1912年）：推行剃发易服、八旗制度与票号银庄，晚清出现早期煤油灯、电报、照相馆与近代轮船租界并存的过渡奇观。',
    attire: '男子留辫并著长袍马褂/箭袖袍、瓜皮帽或暖帽凉帽；满族女子著旗装大拉翅/两把头配花盆底鞋，汉族女子仍见上袄下裙与云肩。',
    artifacts: '盖碗茶具、紫砂茶壶、珐琅彩/粉彩瓷器、雕花红木太师椅、旱烟袋、算盘、铜锁柜匣；晚清可出现早期汽灯与怀表。',
    architecture: '北方青砖灰瓦四合院（垂花门、影壁、游廊）、精雕梁枋彩画与琉璃官式屋顶。',
    lighting: '高墙院落窄天光、室内雕花窗格投影、煤油灯或灯笼暖光，讲究光影纵深与厚重陈旧感。',
    taboos: '注意区分清初金钱鼠尾辫与晚清粗大长辫；早期不得出现电灯、胶片相机或民国中山装/改良短旗袍。',
    visualCues: 'Qing dynasty courtyard house timber veranda, carved lattice window shadows, covered teacup gaiwan, traditional mandarin jacket over long gown, aged grey brick masonry'
  },
  {
    id: 'republic',
    eraLabel: '民国 · 旧日山河与近代人文',
    keywords: ['民国', '191', '192', '193', '194', '上海', '北平', '南京', '旗袍', '报馆', '火车站'],
    chronology: '中华民国时期（1912—1949年）：中西建筑民俗剧烈交融，石库门、有轨电车、铅字印刷报馆、无线电与胶片电影院同框共生。',
    attire: '知识分子与市民常见长衫配圆框眼镜、中山装、三件套粗花呢西服配礼帽；女性常见民国海派改良修身旗袍配针织开衫或学生装（布鞋白袜）。',
    artifacts: '黄铜台灯、手摇老式电话、老式打字机、铅字排版架、搪瓷茶缸、油纸伞、留声机黑胶唱片与蒸汽火车头。',
    architecture: '海派石库门弄堂、租界新古典花岗岩大楼、北平青砖胡同与木结构老车站月台。',
    lighting: '阴雨反光青石路面、路灯钨丝暖晕与冷蓝夜雾、百叶窗条纹光影（Film Noir）。',
    taboos: '严禁画面穿帮出现现代塑料水瓶、空调外机、LED 灯牌、柏油路白黄标线、铝合金防盗窗与当代字体招牌。',
    visualCues: '1930s Shanghai stone-gate alleyway in rain, brass desk lamp glow, tailored scholar long gown and wool fedora, vintage steam train mist, tungsten streetlamp reflections on wet cobblestones'
  }
]

export function matchHistoricalKnowledge(
  storyEra: string,
  prompt: string
): HistoricalEraKnowledge[] {
  const haystack = `${storyEra} ${prompt}`.toLowerCase()
  const scored = HISTORICAL_KNOWLEDGE_BASE.map((entry) => {
    let score = 0
    if (storyEra && (entry.eraLabel.includes(storyEra) || storyEra.includes(entry.eraLabel.split(' · ')[0]))) {
      score += 5
    }
    for (const kw of entry.keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        score += 2
      }
    }
    return { entry, score }
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, 2).map((x) => x.entry)
}

export function formatHistoricalKnowledgeBrief(entries: HistoricalEraKnowledge[]): string {
  if (!entries.length) return ''
  return entries
    .map((e) =>
      [
        `【本地历史知识库档案 · ${e.eraLabel}】`,
        `- 时代制度：${e.chronology}`,
        `- 服饰冠带：${e.attire}`,
        `- 器物饮食：${e.artifacts}`,
        `- 建筑营造：${e.architecture}`,
        `- 光影材质：${e.lighting}`,
        `- 穿帮禁忌：${e.taboos}`,
        `- I2V 史实视觉词库：${e.visualCues}`
      ].join('\n')
    )
    .join('\n\n')
}

// Rótulos traduzidos dos nomes fictícios de projeto (shared/world/floor-names.ts): cada andar de um prédio no mundo
// ganha um id da lista, sorteado pelo servidor a partir do id aleatório do andar, e quem visita vê "Projeto Ipê"
// ("Project Ipê", "Proyecto Ipê", "Projet Ipê"). O rótulo muda junto com o id do andar (24 h ± 6 h).
import { tr } from '../i18n';
import { FLOOR_NAME_IDS, type FloorNameId } from './floor-names';

const LABELS: Record<FloorNameId, () => string> = {
  // Árvores
  ipe: () => tr('Project Ipê'),
  jacaranda: () => tr('Project Jacaranda'),
  jatoba: () => tr('Project Jatobá'),
  peroba: () => tr('Project Peroba'),
  cedro: () => tr('Project Cedar'),
  aroeira: () => tr('Project Aroeira'),
  araucaria: () => tr('Project Araucaria'),
  buriti: () => tr('Project Buriti'),
  carnauba: () => tr('Project Carnauba'),
  figueira: () => tr('Project Fig Tree'),
  oliveira: () => tr('Project Olive Tree'),
  carvalho: () => tr('Project Oak'),
  salgueiro: () => tr('Project Willow'),
  sequoia: () => tr('Project Sequoia'),
  baoba: () => tr('Project Baobab'),
  acacia: () => tr('Project Acacia'),
  magnolia: () => tr('Project Magnolia'),
  cerejeira: () => tr('Project Cherry Tree'),
  pinheiro: () => tr('Project Pine'),
  palmeira: () => tr('Project Palm'),
  // Pedras
  jade: () => tr('Project Jade'),
  ambar: () => tr('Project Amber'),
  ametista: () => tr('Project Amethyst'),
  quartzo: () => tr('Project Quartz'),
  topazio: () => tr('Project Topaz'),
  turmalina: () => tr('Project Tourmaline'),
  agata: () => tr('Project Agate'),
  onix: () => tr('Project Onyx'),
  opala: () => tr('Project Opal'),
  safira: () => tr('Project Sapphire'),
  rubi: () => tr('Project Ruby'),
  esmeralda: () => tr('Project Emerald'),
  granada: () => tr('Project Garnet'),
  jaspe: () => tr('Project Jasper'),
  malaquita: () => tr('Project Malachite'),
  obsidiana: () => tr('Project Obsidian'),
  turquesa: () => tr('Project Turquoise'),
  citrino: () => tr('Project Citrine'),
  peridoto: () => tr('Project Peridot'),
  lapislazuli: () => tr('Project Lapis Lazuli'),
  // Constelações (e a aurora)
  aurora: () => tr('Project Aurora'),
  orion: () => tr('Project Orion'),
  lyra: () => tr('Project Lyra'),
  cygnus: () => tr('Project Cygnus'),
  draco: () => tr('Project Draco'),
  andromeda: () => tr('Project Andromeda'),
  cassiopeia: () => tr('Project Cassiopeia'),
  perseus: () => tr('Project Perseus'),
  phoenix: () => tr('Project Phoenix'),
  hydra: () => tr('Project Hydra'),
  aquila: () => tr('Project Aquila'),
  carina: () => tr('Project Carina'),
  vela: () => tr('Project Vela'),
  centaurus: () => tr('Project Centaurus'),
  crux: () => tr('Project Crux'),
  pavo: () => tr('Project Pavo'),
  columba: () => tr('Project Columba'),
  auriga: () => tr('Project Auriga'),
  lupus: () => tr('Project Lupus'),
  tucana: () => tr('Project Tucana'),
};

export function isFloorNameId(v: unknown): v is FloorNameId {
  return typeof v === 'string' && (FLOOR_NAME_IDS as readonly string[]).includes(v);
}

/** "Projeto Ipê" no idioma atual; um id que esta versão não conhece vira só "Projeto". */
export function floorLabel(id: string): string {
  return isFloorNameId(id) ? LABELS[id]() : tr('Project');
}

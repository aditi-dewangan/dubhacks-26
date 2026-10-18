import imgBox      from './assets/menu/box_combo_new.avif'
import img3Finger  from './assets/menu/3finger_combo_new.avif'
import imgCaniac   from './assets/menu/caniac_combo.avif'
import imgSandwich from './assets/menu/sandwich_combo_new.avif'
import imgTailgate from './assets/menu/canestailgate-25.avif'
import imgFinger   from './assets/menu/chicken-finger-medium0830.avif'
import imgFries    from './assets/menu/fries_recrop.avif'
import imgSauce    from './assets/menu/sauce-medium0830.avif'

export interface MenuItem {
  id: string
  name: string
  price: number
  description: string
  image: string
  category: 'combo' | 'individual' | 'tailgate'
}

export const MENU_ITEMS: MenuItem[] = [
  {
    id: 'box',
    name: 'The Box Combo',
    price: 13.49,
    description: '4 Chicken Fingers, Crinkle-Cut Fries, Coleslaw, Cane\'s Sauce, Texas Toast',
    image: imgBox,
    category: 'combo',
  },
  {
    id: '3finger',
    name: '3 Finger Combo',
    price: 10.99,
    description: '3 Chicken Fingers, Crinkle-Cut Fries, Cane\'s Sauce, Texas Toast',
    image: img3Finger,
    category: 'combo',
  },
  {
    id: 'caniac',
    name: 'The Caniac Combo',
    price: 16.49,
    description: '6 Chicken Fingers, Crinkle-Cut Fries, Coleslaw, 2 Cane\'s Sauces, 2 Texas Toasts',
    image: imgCaniac,
    category: 'combo',
  },
  {
    id: 'sandwich',
    name: 'Sandwich Combo',
    price: 10.99,
    description: 'Chicken Sandwich, Fries, Cane\'s Sauce',
    image: imgSandwich,
    category: 'combo',
  },
  {
    id: 'tailgate',
    name: 'Tailgate (25)',
    price: 40.99,
    description: '25 Chicken Fingers, 8 Cane\'s Sauces',
    image: imgTailgate,
    category: 'tailgate',
  },
  {
    id: 'finger',
    name: 'Chicken Finger',
    price: 2.29,
    description: 'One perfectly cooked chicken finger',
    image: imgFinger,
    category: 'individual',
  },
  {
    id: 'fries',
    name: 'Crinkle-Cut Fries',
    price: 3.49,
    description: 'Crispy golden fries',
    image: imgFries,
    category: 'individual',
  },
  {
    id: 'sauce',
    name: 'Cane\'s Sauce',
    price: 0.50,
    description: 'The one and only',
    image: imgSauce,
    category: 'individual',
  },
]

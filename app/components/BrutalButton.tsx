import { ReactNode } from 'react';
import { motion, HTMLMotionProps } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { playClick, playBack } from '../../lib/sounds';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type BrutalButtonProps = HTMLMotionProps<"button"> & {
  color?: 'magenta' | 'yellow' | 'green' | 'cyan' | 'red' | 'surface';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  sound?: 'click' | 'back' | 'none';
  children: ReactNode;
};

const shadowColors = {
  magenta: '#8A0041',
  yellow: '#997B00',
  green: '#00663E',
  cyan: '#007594',
  red: '#8A0000',
  surface: '#000000'
};

export function BrutalButton({ className, color = 'magenta', size = 'md', sound = 'click', children, onClick, ...props }: BrutalButtonProps) {
  const sizeClasses = {
    sm: 'px-4 py-2 text-sm border-2 rounded-xl shadow-[2px_2px_0px_0px]',
    md: 'px-6 py-3 text-lg border-[3px] rounded-2xl shadow-[4px_4px_0px_0px]',
    lg: 'px-8 py-4 text-2xl border-4 rounded-[20px] shadow-[6px_6px_0px_0px]',
    xl: 'px-12 py-6 text-4xl border-4 rounded-[24px] shadow-[8px_8px_0px_0px]'
  };

  const baseShadow = {
    sm: '2px 2px 0px 0px',
    md: '4px 4px 0px 0px',
    lg: '6px 6px 0px 0px',
    xl: '8px 8px 0px 0px'
  }[size];

  const shColor = shadowColors[color];

  return (
    <motion.button
      whileHover={{ scale: 1.05, y: -3 }}
      whileTap={{
        scale: 0.95,
        x: parseInt(baseShadow),
        y: parseInt(baseShadow),
        boxShadow: `0px 0px 0px 0px ${shColor}`
      }}
      transition={{ type: 'spring', stiffness: 500, damping: 15 }}
      initial={{ boxShadow: `${baseShadow} ${shColor}` }}
      style={{ boxShadow: `${baseShadow} ${shColor}` }}
      className={cn(
        'font-display font-extrabold uppercase tracking-wide transition-colors active:shadow-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
        {
          'bg-[var(--magenta)] border-[#8A0041] text-white': color === 'magenta',
          'bg-[var(--yellow)] border-[#997B00] text-[#0E0E16]': color === 'yellow',
          'bg-[var(--green)] border-[#00663E] text-[#0E0E16]': color === 'green',
          'bg-[var(--cyan)] border-[#007594] text-[#0E0E16]': color === 'cyan',
          'bg-[var(--red)] border-[#8A0000] text-white': color === 'red',
          'bg-[var(--surface)] border-black text-white': color === 'surface',
        },
        sizeClasses[size],
        className
      )}
      onClick={(e) => { if (sound === 'back') playBack(); else if (sound !== 'none') playClick(); onClick?.(e); }}
      {...props}
    >
      {children}
    </motion.button>
  );
}

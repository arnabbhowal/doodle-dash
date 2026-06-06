import { ReactNode } from 'react';
import { motion, HTMLMotionProps } from 'motion/react';
import { cn } from './BrutalButton';

type BrutalCardProps = HTMLMotionProps<"div"> & {
  color?: 'surface' | 'magenta' | 'yellow' | 'green' | 'cyan' | 'red';
  shadowColor?: string;
  children: ReactNode;
};

export function BrutalCard({ className, color = 'surface', shadowColor = '#000000', children, ...props }: BrutalCardProps) {
  return (
    <motion.div
      className={cn(
        'border-4 rounded-[24px] p-6',
        {
          'bg-[var(--surface)] border-black': color === 'surface',
          'bg-[var(--magenta)] border-[#8A0041]': color === 'magenta',
          'bg-[var(--yellow)] border-[#997B00]': color === 'yellow',
          'bg-[var(--green)] border-[#00663E]': color === 'green',
          'bg-[var(--cyan)] border-[#007594]': color === 'cyan',
          'bg-[var(--red)] border-[#8A0000]': color === 'red',
        },
        className
      )}
      style={{ boxShadow: `8px 8px 0px 0px ${shadowColor}` }}
      {...props}
    >
      {children}
    </motion.div>
  );
}
